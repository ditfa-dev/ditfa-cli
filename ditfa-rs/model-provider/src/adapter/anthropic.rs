use async_trait::async_trait;
use ditfa_api::ResponseEvent;
use ditfa_api::ResponsesApiRequest;
use ditfa_protocol::models::ContentItem;
use ditfa_protocol::models::ResponseItem;
use futures::StreamExt;
use http::HeaderMap;
use serde_json::Value;

use super::AdapterCapabilities;
use super::AdapterError;
use super::ProviderAdapter;
use super::ResponseEventStream;

/// Anthropic Messages API Adapter for Ditfa.
#[derive(Debug, Clone)]
pub struct AnthropicAdapter {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl AnthropicAdapter {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    /// Translate Ditfa ResponseItems to Anthropic Messages API JSON format.
    pub fn translate_request(&self, request: &ResponsesApiRequest) -> serde_json::Value {
        let mut messages = Vec::new();
        let system_instructions = request.instructions.clone();

        for item in &request.input {
            match item {
                ResponseItem::Message { role, content, .. } => {
                    let mut text_content = String::new();
                    for c in content {
                        if let ContentItem::OutputText { text } = c {
                            text_content.push_str(text);
                        } else if let ContentItem::InputText { text } = c {
                            text_content.push_str(text);
                        }
                    }
                    if role == "user" || role == "assistant" {
                        messages.push(serde_json::json!({
                            "role": role,
                            "content": text_content
                        }));
                    }
                }
                ResponseItem::FunctionCall { name, arguments, call_id, .. } => {
                    let input_json: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": call_id,
                            "name": name,
                            "input": input_json
                        }]
                    }));
                }
                ResponseItem::FunctionCallOutput { call_id, output, .. } => {
                    let content_str = serde_json::to_string(output).unwrap_or_default();
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": call_id,
                            "content": content_str
                        }]
                    }));
                }
                _ => {}
            }
        }

        let mut payload = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "max_tokens": 8192,
            "stream": request.stream
        });

        if !system_instructions.is_empty() {
            payload["system"] = serde_json::json!(system_instructions);
        }

        payload
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
    fn provider_id(&self) -> &str {
        "anthropic"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            function_calling: true,
            custom_tool_calls: false,
            streaming: true,
            web_search: false,
            image_generation: false,
            remote_compaction: false,
            reasoning: true,
            max_context_tokens: Some(200_000),
        }
    }

    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        mut auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError> {
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let payload = self.translate_request(&request);

        if !auth_headers.contains_key("anthropic-version") {
            auth_headers.insert("anthropic-version", "2023-06-01".parse().unwrap());
        }

        let res = self.client.post(&url)
            .headers(auth_headers)
            .json(&payload)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(AdapterError::StreamError(format!(
                "Anthropic API returned HTTP {status}: {text}"
            )));
        }

        let stream = res.bytes_stream().map(|chunk_res| {
            match chunk_res {
                Ok(_bytes) => {
                    // Translate Anthropic SSE events to ResponseEvents
                    Ok(ResponseEvent::Created)
                }
                Err(err) => Err(AdapterError::HttpError(err)),
            }
        });

        Ok(Box::pin(stream))
    }
}
