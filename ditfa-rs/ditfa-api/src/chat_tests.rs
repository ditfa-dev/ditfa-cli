use super::*;
use crate::common::Reasoning;
use crate::common::TextControls;
use crate::common::TextFormat;
use crate::common::TextFormatType;
use bytes::Bytes;
use ditfa_client::TransportError;
use ditfa_protocol::models::ContentItem;
use ditfa_protocol::openai_models::ReasoningEffort as ReasoningEffortConfig;
use pretty_assertions::assert_eq;
use serde_json::value::RawValue;

fn item(value: Value) -> ResponseItem {
    serde_json::from_value(value).expect("valid response item")
}

fn request(input: Vec<ResponseItem>, tools: Value) -> ResponsesApiRequest {
    let tools = RawValue::from_string(tools.to_string()).expect("valid tools JSON");
    ResponsesApiRequest {
        model: "ditfa-test".into(),
        instructions: "You are a coding agent.".into(),
        input,
        tools: Some(Arc::<RawValue>::from(tools).into()),
        tool_choice: "auto".into(),
        parallel_tool_calls: true,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: Vec::new(),
        service_tier: None,
        prompt_cache_key: None,
        text: None,
        client_metadata: None,
    }
}

fn tools() -> Value {
    json!([
        {
            "type": "function",
            "name": "shell",
            "description": "Run a shell command",
            "strict": false,
            "parameters": { "type": "object", "properties": { "command": { "type": "string" } } },
        },
        {
            "type": "custom",
            "name": "apply_patch",
            "description": "Apply a patch",
            "format": { "type": "grammar", "syntax": "lark", "definition": "start: patch" },
        },
        {
            "type": "namespace",
            "name": "mcp__github",
            "description": "GitHub tools",
            "tools": [{
                "type": "function",
                "name": "create_issue",
                "description": "Create an issue",
                "parameters": { "type": "object", "properties": {} },
            }],
        },
        { "type": "web_search" },
    ])
}

#[test]
fn builds_messages_tools_and_options() {
    let input = vec![
        item(json!({
            "type": "message",
            "role": "developer",
            "content": [{ "type": "input_text", "text": "Sandbox: workspace-write" }],
        })),
        item(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "Fix the bug" }],
        })),
        item(json!({
            "type": "reasoning",
            "summary": [],
            "content": [{ "type": "reasoning_text", "text": "thinking" }],
            "encrypted_content": null,
        })),
        item(json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "Looking." }],
        })),
        item(json!({
            "type": "function_call",
            "name": "shell",
            "arguments": "{\"command\":\"ls\"}",
            "call_id": "call_1",
        })),
        item(json!({
            "type": "custom_tool_call",
            "call_id": "call_2",
            "name": "apply_patch",
            "input": "*** Begin Patch",
        })),
        item(json!({
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "src\n",
        })),
        item(json!({
            "type": "custom_tool_call_output",
            "call_id": "call_2",
            "output": "Done",
        })),
    ];
    let (body, tool_map) = build_chat_request(&request(input, tools())).expect("chat request");

    assert_eq!(
        body["messages"],
        json!([
            { "role": "system", "content": "You are a coding agent.\n\nSandbox: workspace-write" },
            { "role": "user", "content": "Fix the bug" },
            {
                "role": "assistant",
                "content": "Looking.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "shell", "arguments": "{\"command\":\"ls\"}" },
                    },
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": "{\"input\":\"*** Begin Patch\"}",
                        },
                    },
                ],
            },
            { "role": "tool", "tool_call_id": "call_1", "content": "src\n" },
            { "role": "tool", "tool_call_id": "call_2", "content": "Done" },
        ])
    );

    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["function"]["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        names,
        vec!["shell", "apply_patch", "mcp__github__create_issue"]
    );
    assert_eq!(body["tool_choice"], "auto");
    assert_eq!(body["parallel_tool_calls"], true);
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"], json!({ "include_usage": true }));
    assert!(
        body["tools"][1]["function"]["parameters"]["properties"]["input"]["description"]
            .as_str()
            .expect("description")
            .contains("start: patch")
    );

    assert_eq!(
        tool_map.resolve("mcp__github__create_issue"),
        ChatToolTarget {
            name: "create_issue".into(),
            kind: ChatToolKind::Function {
                namespace: Some("mcp__github".into()),
            },
        }
    );
    assert_eq!(
        tool_map.resolve("apply_patch").kind,
        ChatToolKind::Freeform { namespace: None }
    );
}

#[test]
fn omits_tools_and_maps_reasoning_and_schema() {
    let mut chat_request = request(
        vec![ResponseItem::Message {
            id: None,
            role: "user".into(),
            content: vec![ContentItem::InputText { text: "hi".into() }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        json!([]),
    );
    chat_request.reasoning = Some(Reasoning {
        effort: Some(ReasoningEffortConfig::XHigh),
        summary: None,
        context: None,
    });
    chat_request.text = Some(TextControls {
        verbosity: None,
        format: Some(TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: true,
            schema: json!({ "type": "object" }),
            name: "answer".into(),
        }),
    });

    let (body, _) = build_chat_request(&chat_request).expect("chat request");
    assert!(body.get("tools").is_none());
    assert!(body.get("parallel_tool_calls").is_none());
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(
        body["response_format"],
        json!({
            "type": "json_schema",
            "json_schema": { "name": "answer", "schema": { "type": "object" }, "strict": true },
        })
    );
}

#[test]
fn tool_output_images_follow_as_user_message() {
    let input = vec![
        item(json!({
            "type": "function_call",
            "name": "view_image",
            "arguments": "{}",
            "call_id": "call_9",
        })),
        item(json!({
            "type": "function_call_output",
            "call_id": "call_9",
            "output": [
                { "type": "input_text", "text": "screenshot" },
                { "type": "input_image", "image_url": "data:image/png;base64,AAAA" },
            ],
        })),
    ];
    let (body, _) = build_chat_request(&request(input, json!([]))).expect("chat request");
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages[2]["role"], "tool");
    assert_eq!(messages[2]["content"], "screenshot");
    assert_eq!(messages[3]["role"], "user");
    assert_eq!(
        messages[3]["content"][1],
        json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } })
    );
}

#[test]
fn long_function_names_stay_unique_and_valid() {
    let long = "a".repeat(80);
    let first = flatten_name(Some("mcp__server"), &long);
    let second = flatten_name(Some("mcp__other"), &long);
    assert!(first.len() <= MAX_FUNCTION_NAME_LEN);
    assert_ne!(first, second);
    assert_eq!(sanitize_function_name("my.tool name"), "my_tool_name");
}

fn sse(frames: &[&str]) -> ByteStream {
    let body: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    let chunks: Vec<Result<Bytes, TransportError>> = body
        .into_bytes()
        .chunks(7)
        .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
        .collect();
    Box::pin(futures::stream::iter(chunks))
}

async fn collect(frames: &[&str], tool_map: ChatToolMap) -> Vec<Result<ResponseEvent, ApiError>> {
    let (tx, mut rx) = mpsc::channel(64);
    process_chat_sse(sse(frames), tx, tool_map, Duration::from_secs(5), None).await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    events
}

fn ok_events(events: Vec<Result<ResponseEvent, ApiError>>) -> Vec<ResponseEvent> {
    events
        .into_iter()
        .map(|event| event.expect("no stream error"))
        .collect()
}

#[tokio::test]
async fn streams_reasoning_text_and_usage() {
    let events = ok_events(
        collect(
            &[
                r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Let me "}}]}"#,
                r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"think."}}]}"#,
                r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"}}]}"#,
                r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}"#,
                r#"{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":2}}}"#,
                "[DONE]",
            ],
            ChatToolMap::default(),
        )
        .await,
    );

    assert!(matches!(events[0], ResponseEvent::Created));
    assert!(matches!(
        &events[1],
        ResponseEvent::OutputItemAdded(ResponseItem::Reasoning { .. })
    ));
    let reasoning: String = events
        .iter()
        .filter_map(|event| match event {
            ResponseEvent::ReasoningContentDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reasoning, "Let me think.");
    let text: String = events
        .iter()
        .filter_map(|event| match event {
            ResponseEvent::OutputTextDelta(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hello world");

    let done: Vec<&ResponseItem> = events
        .iter()
        .filter_map(|event| match event {
            ResponseEvent::OutputItemDone(item) => Some(item),
            _ => None,
        })
        .collect();
    assert_eq!(done.len(), 2);
    assert!(matches!(done[0], ResponseItem::Reasoning { .. }));
    match done[1] {
        ResponseItem::Message { role, content, .. } => {
            assert_eq!(role, "assistant");
            assert_eq!(
                content,
                &vec![ContentItem::OutputText {
                    text: "Hello world".into()
                }]
            );
        }
        other => panic!("expected assistant message, got {other:?}"),
    }

    match events.last() {
        Some(ResponseEvent::Completed {
            response_id,
            token_usage: Some(usage),
            ..
        }) => {
            assert_eq!(response_id, "chatcmpl-1");
            assert_eq!(usage.input_tokens, 10);
            assert_eq!(usage.cached_input_tokens, 4);
            assert_eq!(usage.output_tokens, 5);
            assert_eq!(usage.reasoning_output_tokens, 2);
            assert_eq!(usage.total_tokens, 15);
        }
        other => panic!("expected completed with usage, got {other:?}"),
    }
}

#[tokio::test]
async fn assembles_streamed_tool_calls() {
    let (_, tool_map) = build_chat_request(&request(Vec::new(), tools())).expect("chat request");
    let events = ok_events(
        collect(
            &[
                r#"{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"shell","arguments":""}}]}}]}"#,
                r#"{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}"#,
                r#"{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}"#,
                r#"{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"apply_patch","arguments":"{\"input\":\"*** Begin Patch\"}"}}]}}]}"#,
                r#"{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"id":"call_c","function":{"name":"mcp__github__create_issue","arguments":""}}]},"finish_reason":"tool_calls"}]}"#,
                "[DONE]",
            ],
            tool_map,
        )
        .await,
    );

    let done: Vec<&ResponseItem> = events
        .iter()
        .filter_map(|event| match event {
            ResponseEvent::OutputItemDone(item) => Some(item),
            _ => None,
        })
        .collect();
    assert_eq!(done.len(), 3);
    match done[0] {
        ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            namespace,
            ..
        } => {
            assert_eq!(name, "shell");
            assert_eq!(arguments, "{\"command\":\"ls\"}");
            assert_eq!(call_id, "call_a");
            assert_eq!(namespace, &None);
        }
        other => panic!("expected function call, got {other:?}"),
    }
    match done[1] {
        ResponseItem::CustomToolCall {
            name,
            input,
            call_id,
            ..
        } => {
            assert_eq!(name, "apply_patch");
            assert_eq!(input, "*** Begin Patch");
            assert_eq!(call_id, "call_b");
        }
        other => panic!("expected custom tool call, got {other:?}"),
    }
    match done[2] {
        ResponseItem::FunctionCall {
            name,
            arguments,
            namespace,
            ..
        } => {
            assert_eq!(name, "create_issue");
            assert_eq!(arguments, "{}");
            assert_eq!(namespace.as_deref(), Some("mcp__github"));
        }
        other => panic!("expected namespaced function call, got {other:?}"),
    }
    assert!(matches!(
        events.last(),
        Some(ResponseEvent::Completed { .. })
    ));
}

#[tokio::test]
async fn tool_calls_without_index_or_id() {
    let events = ok_events(
        collect(
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"shell","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            ],
            ChatToolMap::default(),
        )
        .await,
    );
    let call = events.iter().find_map(|event| match event {
        ResponseEvent::OutputItemDone(ResponseItem::FunctionCall { call_id, .. }) => Some(call_id),
        _ => None,
    });
    assert!(call.is_some_and(|id| id.starts_with("call_")));
    assert!(matches!(
        events.last(),
        Some(ResponseEvent::Completed { .. })
    ));
}

#[tokio::test]
async fn closed_stream_without_finish_is_an_error() {
    let events = collect(
        &[r#"{"id":"c3","choices":[{"index":0,"delta":{"content":"partial"}}]}"#],
        ChatToolMap::default(),
    )
    .await;
    assert!(matches!(events.last(), Some(Err(ApiError::Stream(_)))));
}

#[tokio::test]
async fn error_chunks_map_to_api_errors() {
    let events = collect(
        &[r#"{"error":{"message":"too long","type":"invalid_request_error","code":"context_length_exceeded"}}"#],
        ChatToolMap::default(),
    )
    .await;
    assert!(matches!(
        events.last(),
        Some(Err(ApiError::ContextWindowExceeded))
    ));

    let events = collect(
        &[r#"{"error":{"message":"Credit limit reached.","type":"insufficient_quota","code":"insufficient_quota"}}"#],
        ChatToolMap::default(),
    )
    .await;
    assert!(matches!(events.last(), Some(Err(ApiError::QuotaExceeded))));
}
