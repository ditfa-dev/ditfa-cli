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

/// Google Gemini API Adapter for Ditfa.
#[derive(Debug, Clone)]
pub struct GeminiAdapter {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl GeminiAdapter {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    /// Translate Ditfa ResponseItems into Gemini contents JSON array.
    pub fn translate_request(&self, request: &ResponsesApiRequest) -> serde_json::Value {
        let mut contents = Vec::new();

        for item in &request.input {
            if let ResponseItem::Message { role, content, .. } = item {
                let mut text = String::new();
                for c in content {
                    if let ContentItem::OutputText { text: t } | ContentItem::InputText { text: t } = c {
                        text.push_str(t);
                    }
                }
                let gemini_role = if role == "user" { "user" } else { "model" };
                contents.push(serde_json::json!({
                    "role": gemini_role,
                    "parts": [{ "text": text }]
                }));
            }
        }

        let mut payload = serde_json::json!({
            "contents": contents
        });

        if !request.instructions.is_empty() {
            payload["systemInstruction"] = serde_json::json!({
                "parts": [{ "text": request.instructions }]
            });
        }

        payload
    }
}

#[async_trait]
impl ProviderAdapter for GeminiAdapter {
    fn provider_id(&self) -> &str {
        "gemini"
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
            max_context_tokens: Some(1_000_000),
        }
    }

    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError> {
        let action = if request.stream { "streamGenerateContent" } else { "generateContent" };
        let url = format!(
            "{}/v1beta/models/{}:{}?alt=sse",
            self.base_url.trim_end_matches('/'),
            request.model,
            action
        );

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
                "Gemini API returned HTTP {status}: {text}"
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
