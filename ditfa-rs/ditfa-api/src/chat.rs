//! OpenAI-compatible Chat Completions support.
//!
//! The agent core speaks the Responses data model (`ResponseItem`, `ResponseEvent`). Most hosted
//! and local model servers — Ditfa, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, vLLM,
//! LM Studio, Ollama — expose `/chat/completions` instead. This module translates a
//! [`ResponsesApiRequest`] into a Chat Completions body and turns the streamed
//! `chat.completion.chunk` frames back into the [`ResponseEvent`] sequence the core expects:
//! `Created`, `OutputItemAdded`/deltas/`OutputItemDone` per item, then `Completed`.
//!
//! The translation works on the JSON wire shapes of both APIs rather than on the Rust types, so it
//! keeps working when internal item variants gain fields.

use crate::common::ResponseEvent;
use crate::common::ResponseStream;
use crate::common::ResponsesApiRequest;
use crate::error::ApiError;
use crate::telemetry::SseTelemetry;
use ditfa_client::ByteStream;
use ditfa_client::StreamResponse;
use ditfa_protocol::models::ResponseItem;
use ditfa_protocol::protocol::TokenUsage;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio::time::timeout;
use tracing::debug;
use tracing::trace;

/// Name of the single string argument used when a freeform (`custom`) tool is exposed as a
/// Chat Completions function.
const FREEFORM_INPUT_ARG: &str = "input";
/// Separator between a tool namespace and the tool name in flattened function names.
const NAMESPACE_SEPARATOR: &str = "__";
/// Chat Completions function names are limited to 64 characters.
const MAX_FUNCTION_NAME_LEN: usize = 64;

/// How a function name sent to the model maps back to the core's tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChatToolKind {
    Function { namespace: Option<String> },
    Freeform { namespace: Option<String> },
    LocalShell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChatToolTarget {
    pub(crate) name: String,
    pub(crate) kind: ChatToolKind,
}

/// Function names advertised to the model, keyed by the name the model will call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ChatToolMap {
    tools: HashMap<String, ChatToolTarget>,
}

impl ChatToolMap {
    fn insert(&mut self, wire_name: String, target: ChatToolTarget) {
        self.tools.insert(wire_name, target);
    }

    fn resolve(&self, wire_name: &str) -> ChatToolTarget {
        self.tools
            .get(wire_name)
            .cloned()
            .unwrap_or_else(|| ChatToolTarget {
                name: wire_name.to_string(),
                kind: ChatToolKind::Function { namespace: None },
            })
    }
}

fn flatten_name(namespace: Option<&str>, name: &str) -> String {
    let full = match namespace {
        Some(namespace) if !namespace.is_empty() => {
            format!("{namespace}{NAMESPACE_SEPARATOR}{name}")
        }
        _ => name.to_string(),
    };
    sanitize_function_name(&full)
}

/// Keeps names within `^[a-zA-Z0-9_-]{1,64}$`, which every Chat Completions server accepts.
fn sanitize_function_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.len() <= MAX_FUNCTION_NAME_LEN {
        return cleaned;
    }
    // Keep a stable, unique suffix so two long names do not collapse into one.
    let hash = cleaned
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |acc, byte| {
            (acc ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
    let suffix = format!("_{hash:016x}");
    let keep = MAX_FUNCTION_NAME_LEN - suffix.len();
    format!("{}{suffix}", &cleaned[..keep])
}

/// Translates a Responses request into a Chat Completions request body.
pub(crate) fn build_chat_request(
    request: &ResponsesApiRequest,
) -> Result<(Value, ChatToolMap), ApiError> {
    let wire = serde_json::to_value(request)
        .map_err(|err| ApiError::Stream(format!("failed to encode chat request: {err}")))?;

    let mut tool_map = ChatToolMap::default();
    let tools = wire
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| convert_tools(tools, &mut tool_map))
        .unwrap_or_default();

    let input = wire
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let messages = convert_input(&request.instructions, &input, &tool_map);

    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("stream_options".into(), json!({ "include_usage": true }));
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert("tool_choice".into(), Value::String("auto".into()));
        if request.parallel_tool_calls {
            body.insert("parallel_tool_calls".into(), Value::Bool(true));
        }
    }
    if let Some(effort) = wire
        .pointer("/reasoning/effort")
        .and_then(Value::as_str)
        .and_then(chat_reasoning_effort)
    {
        body.insert("reasoning_effort".into(), Value::String(effort.into()));
    }
    if let Some(format) = wire.pointer("/text/format").and_then(response_format) {
        body.insert("response_format".into(), format);
    }
    Ok((Value::Object(body), tool_map))
}

/// Chat Completions servers accept `low | medium | high`; map the wider Responses scale onto it.
fn chat_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" => Some("high"),
        _ => None,
    }
}

fn response_format(format: &Value) -> Option<Value> {
    if format.get("type").and_then(Value::as_str) != Some("json_schema") {
        return None;
    }
    let schema = format.get("schema")?.clone();
    let name = format
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let strict = format
        .get("strict")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(json!({
        "type": "json_schema",
        "json_schema": { "name": name, "schema": schema, "strict": strict },
    }))
}

fn convert_tools(tools: &[Value], tool_map: &mut ChatToolMap) -> Vec<Value> {
    let mut out = Vec::new();
    for tool in tools {
        convert_tool(tool, /*namespace*/ None, tool_map, &mut out);
    }
    out
}

fn convert_tool(
    tool: &Value,
    namespace: Option<&str>,
    tool_map: &mut ChatToolMap,
    out: &mut Vec<Value>,
) {
    let Some(name) = tool.get("name").and_then(Value::as_str) else {
        if tool.get("type").and_then(Value::as_str) == Some("local_shell") {
            out.push(local_shell_function());
            tool_map.insert(
                "local_shell".into(),
                ChatToolTarget {
                    name: "local_shell".into(),
                    kind: ChatToolKind::LocalShell,
                },
            );
        }
        return;
    };
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match tool.get("type").and_then(Value::as_str) {
        Some("function") => {
            let wire_name = flatten_name(namespace, name);
            let parameters = tool
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            out.push(json!({
                "type": "function",
                "function": {
                    "name": wire_name,
                    "description": description,
                    "parameters": parameters,
                },
            }));
            tool_map.insert(
                wire_name,
                ChatToolTarget {
                    name: name.to_string(),
                    kind: ChatToolKind::Function {
                        namespace: namespace.map(str::to_string),
                    },
                },
            );
        }
        Some("custom") => {
            let wire_name = flatten_name(namespace, name);
            let mut input_description = String::from(
                "The complete raw input for this tool, exactly as the tool expects it.",
            );
            if let Some(definition) = tool.pointer("/format/definition").and_then(Value::as_str) {
                input_description.push_str(" It must match this grammar:\n");
                input_description.push_str(definition);
            }
            out.push(json!({
                "type": "function",
                "function": {
                    "name": wire_name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            FREEFORM_INPUT_ARG: {
                                "type": "string",
                                "description": input_description,
                            },
                        },
                        "required": [FREEFORM_INPUT_ARG],
                        "additionalProperties": false,
                    },
                },
            }));
            tool_map.insert(
                wire_name,
                ChatToolTarget {
                    name: name.to_string(),
                    kind: ChatToolKind::Freeform {
                        namespace: namespace.map(str::to_string),
                    },
                },
            );
        }
        Some("namespace") => {
            if let Some(children) = tool.get("tools").and_then(Value::as_array) {
                for child in children {
                    convert_tool(child, Some(name), tool_map, out);
                }
            }
        }
        // Hosted tools (web search, image generation, tool search, ...) only exist on the
        // Responses API.
        _ => {}
    }
}

fn local_shell_function() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "local_shell",
            "description": "Runs a command on the user's machine and returns its output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "array", "items": { "type": "string" } },
                    "working_directory": { "type": "string" },
                    "timeout_ms": { "type": "integer" },
                },
                "required": ["command"],
            },
        },
    })
}

/// Accumulates the assistant turn that is being rebuilt from consecutive Responses items.
#[derive(Default)]
struct PendingAssistant {
    text: String,
    tool_calls: Vec<Value>,
}

impl PendingAssistant {
    fn is_empty(&self) -> bool {
        self.text.is_empty() && self.tool_calls.is_empty()
    }

    fn flush(&mut self, messages: &mut Vec<Value>) {
        if self.is_empty() {
            return;
        }
        let mut message = Map::new();
        message.insert("role".into(), Value::String("assistant".into()));
        message.insert(
            "content".into(),
            if self.text.is_empty() {
                Value::Null
            } else {
                Value::String(std::mem::take(&mut self.text))
            },
        );
        if !self.tool_calls.is_empty() {
            message.insert(
                "tool_calls".into(),
                Value::Array(std::mem::take(&mut self.tool_calls)),
            );
        }
        messages.push(Value::Object(message));
    }
}

fn convert_input(instructions: &str, input: &[Value], tool_map: &ChatToolMap) -> Vec<Value> {
    // Reverse lookup so calls made in earlier turns are replayed under the same function name.
    let wire_names: HashMap<(Option<String>, String), String> = tool_map
        .tools
        .iter()
        .map(|(wire, target)| {
            let namespace = match &target.kind {
                ChatToolKind::Function { namespace } | ChatToolKind::Freeform { namespace } => {
                    namespace.clone()
                }
                ChatToolKind::LocalShell => None,
            };
            ((namespace, target.name.clone()), wire.clone())
        })
        .collect();
    let wire_name = |namespace: Option<&str>, name: &str| {
        wire_names
            .get(&(namespace.map(str::to_string), name.to_string()))
            .cloned()
            .unwrap_or_else(|| flatten_name(namespace, name))
    };

    let mut messages = Vec::new();
    let mut system = instructions.trim().to_string();
    let mut seen_conversation = false;
    let mut pending = PendingAssistant::default();
    let mut deferred_images: Vec<Value> = Vec::new();

    let flush_images = |messages: &mut Vec<Value>, images: &mut Vec<Value>| {
        if images.is_empty() {
            return;
        }
        let mut content = vec![json!({
            "type": "text",
            "text": "Images returned by the previous tool call:",
        })];
        content.append(images);
        messages.push(json!({ "role": "user", "content": content }));
    };

    for item in input {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice);
                match role {
                    "assistant" => {
                        flush_images(&mut messages, &mut deferred_images);
                        let text = content.map(text_of).unwrap_or_default();
                        if !pending.tool_calls.is_empty() {
                            pending.flush(&mut messages);
                        }
                        pending.text.push_str(&text);
                    }
                    "system" | "developer" if !seen_conversation => {
                        let text = content.map(text_of).unwrap_or_default();
                        if !text.trim().is_empty() {
                            if !system.is_empty() {
                                system.push_str("\n\n");
                            }
                            system.push_str(text.trim());
                        }
                    }
                    _ => {
                        pending.flush(&mut messages);
                        flush_images(&mut messages, &mut deferred_images);
                        seen_conversation = true;
                        let chat_role = if role == "user" { "user" } else { "system" };
                        let parts = content.map(user_content).unwrap_or_default();
                        if !parts.is_empty() {
                            messages.push(json!({ "role": chat_role, "content": simplify(parts) }));
                        }
                    }
                }
            }
            "function_call" => {
                flush_images(&mut messages, &mut deferred_images);
                let namespace = item.get("namespace").and_then(Value::as_str);
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                pending
                    .tool_calls
                    .push(tool_call(call_id, &wire_name(namespace, name), arguments));
                seen_conversation = true;
            }
            "custom_tool_call" => {
                flush_images(&mut messages, &mut deferred_images);
                let namespace = item.get("namespace").and_then(Value::as_str);
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let input = item
                    .get("input")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = json!({ FREEFORM_INPUT_ARG: input }).to_string();
                pending.tool_calls.push(tool_call(
                    call_id,
                    &wire_name(namespace, name),
                    &arguments,
                ));
                seen_conversation = true;
            }
            "local_shell_call" => {
                flush_images(&mut messages, &mut deferred_images);
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("id").and_then(Value::as_str))
                    .unwrap_or_default();
                let arguments = item
                    .get("action")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".into());
                pending
                    .tool_calls
                    .push(tool_call(call_id, "local_shell", &arguments));
                seen_conversation = true;
            }
            "function_call_output" | "custom_tool_call_output" => {
                pending.flush(&mut messages);
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let (text, images) = tool_output(item.get("output"));
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": text,
                }));
                deferred_images.extend(images);
            }
            // Reasoning, hosted-tool calls, compaction markers and other Responses-only items
            // have no Chat Completions equivalent.
            _ => {}
        }
    }
    pending.flush(&mut messages);
    flush_images(&mut messages, &mut deferred_images);

    if !system.is_empty() {
        messages.insert(0, json!({ "role": "system", "content": system }));
    }
    messages
}

fn tool_call(call_id: &str, name: &str, arguments: &str) -> Value {
    json!({
        "id": call_id,
        "type": "function",
        "function": { "name": name, "arguments": arguments },
    })
}

fn text_of(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn user_content(parts: &[Value]) -> Vec<Value> {
    parts
        .iter()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => part
                .get("text")
                .and_then(Value::as_str)
                .map(|text| json!({ "type": "text", "text": text })),
            Some("input_image") => image_part(part),
            _ => None,
        })
        .collect()
}

fn image_part(part: &Value) -> Option<Value> {
    let url = part.get("image_url").and_then(Value::as_str)?;
    let mut image = json!({ "url": url });
    if let Some(detail) = part.get("detail").and_then(Value::as_str)
        && matches!(detail, "low" | "high" | "auto")
    {
        image["detail"] = Value::String(detail.into());
    }
    Some(json!({ "type": "image_url", "image_url": image }))
}

/// Plain text when the message has no images, so text-only servers accept it.
fn simplify(parts: Vec<Value>) -> Value {
    let text_only = parts
        .iter()
        .all(|part| part.get("type").and_then(Value::as_str) == Some("text"));
    if text_only {
        Value::String(text_of(&parts))
    } else {
        Value::Array(parts)
    }
}

fn tool_output(output: Option<&Value>) -> (String, Vec<Value>) {
    match output {
        Some(Value::String(text)) => (text.clone(), Vec::new()),
        Some(Value::Array(parts)) => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("input_image") => images.extend(image_part(part)),
                    _ => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            texts.push(text);
                        }
                    }
                }
            }
            (texts.join("\n"), images)
        }
        Some(Value::Object(object)) => (
            object
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| Value::Object(object.clone()).to_string()),
            Vec::new(),
        ),
        Some(other) => (other.to_string(), Vec::new()),
        None => (String::new(), Vec::new()),
    }
}

/// Spawns the task that reads a Chat Completions SSE stream and emits Responses events.
pub(crate) fn spawn_chat_stream(
    stream_response: StreamResponse,
    tool_map: ChatToolMap,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
) -> ResponseStream {
    let upstream_request_id = stream_response
        .headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let (tx_event, rx_event) = mpsc::channel::<Result<ResponseEvent, ApiError>>(1600);
    tokio::spawn(async move {
        process_chat_sse(
            stream_response.bytes,
            tx_event,
            tool_map,
            idle_timeout,
            telemetry,
        )
        .await;
    });
    ResponseStream {
        rx_event,
        upstream_request_id,
    }
}

#[derive(Debug, Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenItem {
    Reasoning,
    Message,
}

/// Builds the Responses event sequence from Chat Completions chunks.
struct ChatStreamState {
    tool_map: ChatToolMap,
    response_id: Option<String>,
    item_counter: usize,
    open: Option<(OpenItem, String)>,
    text: String,
    reasoning: String,
    tool_calls: BTreeMap<u64, PartialToolCall>,
    last_tool_index: Option<u64>,
    usage: Option<TokenUsage>,
    finished: bool,
}

impl ChatStreamState {
    fn new(tool_map: ChatToolMap) -> Self {
        Self {
            tool_map,
            response_id: None,
            item_counter: 0,
            open: None,
            text: String::new(),
            reasoning: String::new(),
            tool_calls: BTreeMap::new(),
            last_tool_index: None,
            usage: None,
            finished: false,
        }
    }

    fn next_item_id(&mut self, prefix: &str) -> String {
        self.item_counter += 1;
        let response_id = self.response_id.as_deref().unwrap_or("chat");
        format!("{prefix}_{response_id}_{}", self.item_counter)
    }

    /// Closes the open item, if any, returning its `OutputItemDone` event.
    fn close_open_item(&mut self) -> Option<ResponseEvent> {
        let (kind, id) = self.open.take()?;
        let item = match kind {
            OpenItem::Message => message_item(&id, &std::mem::take(&mut self.text)),
            OpenItem::Reasoning => reasoning_item(&id, &std::mem::take(&mut self.reasoning)),
        }?;
        Some(ResponseEvent::OutputItemDone(item))
    }

    fn open_item(&mut self, kind: OpenItem, events: &mut Vec<ResponseEvent>) {
        if self.open.as_ref().is_some_and(|(open, _)| *open == kind) {
            return;
        }
        events.extend(self.close_open_item());
        let id = self.next_item_id(match kind {
            OpenItem::Message => "msg",
            OpenItem::Reasoning => "rs",
        });
        let added = match kind {
            OpenItem::Message => message_item(&id, ""),
            OpenItem::Reasoning => reasoning_item(&id, ""),
        };
        events.extend(added.map(ResponseEvent::OutputItemAdded));
        self.open = Some((kind, id));
    }

    fn handle_chunk(&mut self, chunk: &Value) -> Result<Vec<ResponseEvent>, ApiError> {
        if let Some(error) = chunk.get("error") {
            return Err(chat_error(error));
        }
        let mut events = Vec::new();
        if self.response_id.is_none()
            && let Some(id) = chunk.get("id").and_then(Value::as_str)
            && !id.is_empty()
        {
            self.response_id = Some(id.to_string());
        }
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.usage = Some(token_usage(usage));
        }
        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return Ok(events);
        };
        for choice in choices {
            if choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                continue;
            }
            if let Some(delta) = choice.get("delta") {
                self.handle_delta(delta, &mut events);
            }
            if choice
                .get("finish_reason")
                .is_some_and(|reason| !reason.is_null())
            {
                self.finished = true;
            }
        }
        Ok(events)
    }

    fn handle_delta(&mut self, delta: &Value, events: &mut Vec<ResponseEvent>) {
        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        if let Some(reasoning) = reasoning {
            self.open_item(OpenItem::Reasoning, events);
            self.reasoning.push_str(reasoning);
            events.push(ResponseEvent::ReasoningContentDelta {
                delta: reasoning.to_string(),
                content_index: 0,
            });
        }
        if let Some(content) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.open_item(OpenItem::Message, events);
            self.text.push_str(content);
            events.push(ResponseEvent::OutputTextDelta(content.to_string()));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                self.handle_tool_call_delta(call);
            }
        }
    }

    fn handle_tool_call_delta(&mut self, call: &Value) {
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let index = match call.get("index").and_then(Value::as_u64) {
            Some(index) => index,
            // Some servers omit `index`: a new id starts a new call, otherwise it continues the
            // last one.
            None => match (id, self.last_tool_index) {
                (Some(id), _) => self
                    .tool_calls
                    .iter()
                    .find(|(_, partial)| partial.id == id)
                    .map(|(index, _)| *index)
                    .unwrap_or(self.tool_calls.len() as u64),
                (None, Some(last)) => last,
                (None, None) => 0,
            },
        };
        self.last_tool_index = Some(index);
        let partial = self.tool_calls.entry(index).or_default();
        if let Some(id) = id {
            partial.id = id.to_string();
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                partial.name.push_str(name);
            }
            match function.get("arguments") {
                Some(Value::String(arguments)) => partial.arguments.push_str(arguments),
                // A few servers send the arguments as an already-parsed object.
                Some(arguments @ Value::Object(_)) => {
                    partial.arguments.push_str(&arguments.to_string());
                }
                _ => {}
            }
        }
    }

    /// Emits the remaining items and the final `Completed` event.
    fn finish(&mut self) -> Vec<ResponseEvent> {
        let mut events: Vec<ResponseEvent> = self.close_open_item().into_iter().collect();
        let calls = std::mem::take(&mut self.tool_calls);
        for (position, (_, call)) in calls.into_iter().enumerate() {
            if call.name.is_empty() {
                continue;
            }
            let call_id = if call.id.is_empty() {
                let response_id = self.response_id.as_deref().unwrap_or("chat");
                format!("call_{response_id}_{position}")
            } else {
                call.id
            };
            let arguments = if call.arguments.trim().is_empty() {
                "{}".to_string()
            } else {
                call.arguments
            };
            let target = self.tool_map.resolve(&call.name);
            if let Some(item) = tool_call_item(&call_id, &target, &arguments) {
                events.push(ResponseEvent::OutputItemDone(item));
            }
        }
        events.push(ResponseEvent::Completed {
            response_id: self
                .response_id
                .clone()
                .unwrap_or_else(|| format!("chat_{}", uuid::Uuid::new_v4())),
            token_usage: self.usage.clone(),
            end_turn: None,
        });
        events
    }
}

fn message_item(id: &str, text: &str) -> Option<ResponseItem> {
    item_from_json(json!({
        "type": "message",
        "id": id,
        "role": "assistant",
        "content": [{ "type": "output_text", "text": text }],
    }))
}

fn reasoning_item(id: &str, text: &str) -> Option<ResponseItem> {
    let content = if text.is_empty() {
        json!([])
    } else {
        json!([{ "type": "reasoning_text", "text": text }])
    };
    item_from_json(json!({
        "type": "reasoning",
        "id": id,
        "summary": [],
        "content": content,
        "encrypted_content": null,
    }))
}

fn tool_call_item(call_id: &str, target: &ChatToolTarget, arguments: &str) -> Option<ResponseItem> {
    let value = match &target.kind {
        ChatToolKind::Function { namespace } => {
            let mut value = json!({
                "type": "function_call",
                "name": target.name,
                "arguments": arguments,
                "call_id": call_id,
            });
            if let Some(namespace) = namespace {
                value["namespace"] = Value::String(namespace.clone());
            }
            value
        }
        ChatToolKind::Freeform { namespace } => {
            let input = serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|args| {
                    args.get(FREEFORM_INPUT_ARG)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| arguments.to_string());
            let mut value = json!({
                "type": "custom_tool_call",
                "call_id": call_id,
                "name": target.name,
                "input": input,
            });
            if let Some(namespace) = namespace {
                value["namespace"] = Value::String(namespace.clone());
            }
            value
        }
        ChatToolKind::LocalShell => {
            let mut action = serde_json::from_str::<Value>(arguments).unwrap_or_else(|_| json!({}));
            if action.get("type").is_none() {
                action["type"] = Value::String("exec".into());
            }
            json!({
                "type": "local_shell_call",
                "call_id": call_id,
                "status": "completed",
                "action": action,
            })
        }
    };
    item_from_json(value)
}

fn item_from_json(value: Value) -> Option<ResponseItem> {
    match serde_json::from_value(value) {
        Ok(item) => Some(item),
        Err(err) => {
            debug!("failed to build response item from chat stream: {err}");
            None
        }
    }
}

fn token_usage(usage: &Value) -> TokenUsage {
    let int = |pointer: &str| usage.pointer(pointer).and_then(Value::as_i64).unwrap_or(0);
    let input_tokens = int("/prompt_tokens");
    let output_tokens = int("/completion_tokens");
    let total_tokens = match int("/total_tokens") {
        0 => input_tokens + output_tokens,
        total => total,
    };
    TokenUsage {
        input_tokens,
        cached_input_tokens: int("/prompt_tokens_details/cached_tokens"),
        cache_write_input_tokens: 0,
        output_tokens,
        reasoning_output_tokens: int("/completion_tokens_details/reasoning_tokens"),
        total_tokens,
    }
}

fn chat_error(error: &Value) -> ApiError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string());
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    match code {
        "context_length_exceeded" => ApiError::ContextWindowExceeded,
        "insufficient_quota" => ApiError::QuotaExceeded,
        "rate_limit_exceeded" | "rate_limit_error" | "server_error" | "overloaded_error" => {
            ApiError::Retryable {
                message,
                delay: None,
            }
        }
        _ => ApiError::Stream(message),
    }
}

pub(crate) async fn process_chat_sse(
    stream: ByteStream,
    tx_event: mpsc::Sender<Result<ResponseEvent, ApiError>>,
    tool_map: ChatToolMap,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
) {
    let mut stream = stream.eventsource();
    let mut state = ChatStreamState::new(tool_map);
    if tx_event.send(Ok(ResponseEvent::Created)).await.is_err() {
        return;
    }

    loop {
        let start = Instant::now();
        let response = timeout(idle_timeout, stream.next()).await;
        if let Some(t) = telemetry.as_ref() {
            t.on_sse_poll(&response, start.elapsed());
        }
        let sse = match response {
            Ok(Some(Ok(sse))) => sse,
            Ok(Some(Err(err))) => {
                debug!("chat SSE error: {err:#}");
                let _ = tx_event.send(Err(ApiError::Stream(err.to_string()))).await;
                return;
            }
            Ok(None) => {
                // Some servers close the connection without `[DONE]`; a finished choice is
                // still a complete response.
                if state.finished {
                    for event in state.finish() {
                        if tx_event.send(Ok(event)).await.is_err() {
                            return;
                        }
                    }
                } else {
                    let _ = tx_event
                        .send(Err(ApiError::Stream(
                            "stream closed before the model finished its response".into(),
                        )))
                        .await;
                }
                return;
            }
            Err(_) => {
                let _ = tx_event
                    .send(Err(ApiError::Stream("idle timeout waiting for SSE".into())))
                    .await;
                return;
            }
        };

        trace!("chat SSE event: {}", &sse.data);
        let data = sse.data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            for event in state.finish() {
                if tx_event.send(Ok(event)).await.is_err() {
                    return;
                }
            }
            return;
        }
        let chunk: Value = match serde_json::from_str(data) {
            Ok(chunk) => chunk,
            Err(err) => {
                debug!("failed to parse chat SSE chunk: {err}, data: {data}");
                continue;
            }
        };
        match state.handle_chunk(&chunk) {
            Ok(events) => {
                for event in events {
                    if tx_event.send(Ok(event)).await.is_err() {
                        return;
                    }
                }
            }
            Err(err) => {
                let _ = tx_event.send(Err(err)).await;
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;
