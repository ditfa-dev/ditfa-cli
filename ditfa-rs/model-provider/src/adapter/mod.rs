//! Provider Adapter Module for Ditfa
//!
//! Provides a unified `ProviderAdapter` trait that translates between
//! Ditfa's internal `ResponseItem` data model and provider-specific wire APIs
//! (OpenAI Responses API, Anthropic Messages API, Google Gemini API, OpenAI-compatible Chat Completions).

pub mod anthropic;
pub mod chat_completions;
pub mod gemini;
pub mod openai;

#[cfg(test)]
mod tests;

use async_trait::async_trait;
use ditfa_api::ResponseEvent;
use ditfa_api::ResponsesApiRequest;
use futures::Stream;
use http::HeaderMap;
use std::fmt;
use std::pin::Pin;

/// Error types for provider adapters.
#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("Provider does not support feature: {feature}")]
    UnsupportedFeature { feature: String },

    #[error("Translation failed: {0}")]
    TranslationError(String),

    #[error("HTTP transport error: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Streaming error: {0}")]
    StreamError(String),
}

/// Declared capability matrix for a model provider adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterCapabilities {
    pub function_calling: bool,
    pub custom_tool_calls: bool,
    pub streaming: bool,
    pub web_search: bool,
    pub image_generation: bool,
    pub remote_compaction: bool,
    pub reasoning: bool,
    pub max_context_tokens: Option<u64>,
}

impl Default for AdapterCapabilities {
    fn default() -> Self {
        Self {
            function_calling: true,
            custom_tool_calls: true,
            streaming: true,
            web_search: false,
            image_generation: false,
            remote_compaction: false,
            reasoning: true,
            max_context_tokens: None,
        }
    }
}

pub type ResponseEventStream =
    Pin<Box<dyn Stream<Item = Result<ResponseEvent, AdapterError>> + Send>>;

/// Trait implemented by model providers to translate requests & responses.
#[async_trait]
pub trait ProviderAdapter: Send + Sync + fmt::Debug {
    /// Returns the provider identifier (e.g. "openai", "anthropic", "gemini", "chat-completions").
    fn provider_id(&self) -> &str;

    /// Declared capabilities of this provider adapter.
    fn capabilities(&self) -> AdapterCapabilities;

    /// Stream a request, translating internal `ResponsesApiRequest` into provider-specific wire format,
    /// and parsing the response back into `ResponseEvent` items.
    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError>;
}
