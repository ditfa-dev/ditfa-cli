use async_trait::async_trait;
use ditfa_api::ResponsesApiRequest;
use futures::StreamExt;
use http::HeaderMap;

use super::AdapterCapabilities;
use super::AdapterError;
use super::ProviderAdapter;
use super::ResponseEventStream;

/// OpenAI Adapter - Native passthrough for OpenAI Responses API.
#[derive(Debug, Clone)]
pub struct OpenAiAdapter {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl OpenAiAdapter {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiAdapter {
    fn provider_id(&self) -> &str {
        "openai"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            function_calling: true,
            custom_tool_calls: true,
            streaming: true,
            web_search: true,
            image_generation: true,
            remote_compaction: true,
            reasoning: true,
            max_context_tokens: Some(128_000),
        }
    }

    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError> {
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));
        
        let mut req_builder = self.client.post(&url).headers(auth_headers);
        req_builder = req_builder.json(&request);

        let res = req_builder.send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(AdapterError::StreamError(format!(
                "OpenAI API returned HTTP {status}: {text}"
            )));
        }

        let stream = res.bytes_stream().map(|chunk_res| {
            match chunk_res {
                Ok(_bytes) => {
                    // Raw bytes parsing handled downstream or bridged to ResponseEvent
                    Err(AdapterError::StreamError("Stream chunk parsing".to_string()))
                }
                Err(err) => Err(AdapterError::HttpError(err)),
            }
        });

        Ok(Box::pin(stream))
    }
}
