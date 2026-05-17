use async_trait::async_trait;
use ditfa_api::ResponseEvent;
use ditfa_api::ResponsesApiRequest;
use ditfa_protocol::models::ContentItem;
use ditfa_protocol::models::ResponseItem;
use futures::StreamExt;
use http::HeaderMap;

use super::AdapterCapabilities;
use super::AdapterError;
use super::ProviderAdapter;
use super::ResponseEventStream;

/// OpenAI-Compatible Chat Completions Adapter (`/v1/chat/completions`).
#[derive(Debug, Clone)]
pub struct ChatCompletionsAdapter {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl ChatCompletionsAdapter {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    /// Translate `ResponsesApiRequest` (ResponseItems) to `/v1/chat/completions` request.
    pub fn translate_request(&self, request: &ResponsesApiRequest) -> serde_json::Value {
        let mut messages = Vec::new();

        if !request.instructions.is_empty() {
            messages.push(serde_json::json!({
                "role": "system",
                "content": request.instructions
            }));
        }

        for item in &request.input {
            match item {
                ResponseItem::Message { role, content, .. } => {
                    let mut text = String::new();
                    for c in content {
                        if let ContentItem::OutputText { text: t } | ContentItem::InputText { text: t } = c {
                            text.push_str(t);
                        }
                    }
                    messages.push(serde_json::json!({
                        "role": role,
                        "content": text
                    }));
                }
                ResponseItem::FunctionCall { name, arguments, call_id, .. } => {
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": arguments
                            }
                        }]
                    }));
                }
                ResponseItem::FunctionCallOutput { call_id, output, .. } => {
                    let content_str = serde_json::to_string(output).unwrap_or_default();
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": content_str
                    }));
                }
                _ => {}
            }
        }

        serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": request.stream
        })
    }
}

#[async_trait]
impl ProviderAdapter for ChatCompletionsAdapter {
    fn provider_id(&self) -> &str {
        "chat-completions"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            function_calling: true,
            custom_tool_calls: false,
            streaming: true,
            web_search: false,
            image_generation: false,
            remote_compaction: false,
            reasoning: false,
            max_context_tokens: Some(32_000),
        }
    }

    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let payload = self.translate_request(&request);

        let res = self.client.post(&url)
            .headers(auth_headers)
            .json(&payload)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(AdapterError::StreamError(format!(
                "Chat Completions API returned HTTP {status}: {text}"
            )));
        }

        let stream = res.bytes_stream().map(|chunk_res| {
            match chunk_res {
                Ok(_bytes) => Ok(ResponseEvent::Created),
                Err(err) => Err(AdapterError::HttpError(err)),
            }
        });

        Ok(Box::pin(stream))
    }
}
