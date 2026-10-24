use crate::auth::SharedAuthProvider;
use crate::chat::build_chat_request;
use crate::chat::spawn_chat_stream;
use crate::common::ResponseStream;
use crate::common::ResponsesApiRequest;
use crate::endpoint::session::EndpointSession;
use crate::error::ApiError;
use crate::provider::Provider;
use crate::requests::headers::build_session_headers;
use crate::requests::headers::insert_header;
use crate::telemetry::SseTelemetry;
use ditfa_client::EncodedJsonBody;
use ditfa_client::HttpTransport;
use ditfa_client::RequestTelemetry;
use ditfa_client::TransportError;
use http::HeaderMap;
use http::HeaderValue;
use http::Method;
use http::StatusCode;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tracing::instrument;
use tracing::warn;

/// Model name that asks the client to use the first model the account can access.
pub const AUTO_MODEL: &str = "auto";

/// Streams turns through an OpenAI-compatible `/chat/completions` endpoint.
pub struct ChatCompletionsClient<T: HttpTransport> {
    session: EndpointSession<T>,
    sse_telemetry: Option<Arc<dyn SseTelemetry>>,
}

#[derive(Default)]
pub struct ChatCompletionsOptions {
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub extra_headers: HeaderMap,
}

/// Model chosen for `auto` (or for a model the server does not know), per base URL, so the
/// lookup happens once per process instead of once per turn.
fn resolved_models() -> &'static Mutex<HashMap<String, String>> {
    static RESOLVED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    RESOLVED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_model(base_url: &str) -> Option<String> {
    resolved_models()
        .lock()
        .ok()
        .and_then(|models| models.get(base_url).cloned())
}

fn remember_model(base_url: &str, model: &str) {
    if let Ok(mut models) = resolved_models().lock() {
        models.insert(base_url.to_string(), model.to_string());
    }
}

/// `true` when the server rejected the request because the model does not exist.
fn is_model_not_found(err: &ApiError) -> bool {
    let ApiError::Transport(TransportError::Http { status, body, .. }) = err else {
        return false;
    };
    if *status != StatusCode::NOT_FOUND && *status != StatusCode::BAD_REQUEST {
        return false;
    }
    let Some(body) = body.as_deref() else {
        return false;
    };
    let code = serde_json::from_str::<Value>(body).ok().and_then(|json| {
        json.pointer("/error/code")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    match code.as_deref() {
        Some(code) => code == "model_not_found",
        None => {
            let body = body.to_ascii_lowercase();
            body.contains("model")
                && (body.contains("not found") || body.contains("does not exist"))
        }
    }
}

/// First model id in an OpenAI-style `GET /models` listing.
pub(crate) fn first_model_id(listing: &Value) -> Option<String> {
    listing
        .get("data")
        .or_else(|| listing.get("models"))
        .and_then(Value::as_array)?
        .iter()
        .find_map(|model| {
            model
                .get("id")
                .or_else(|| model.get("name"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
        })
}

impl<T: HttpTransport> ChatCompletionsClient<T> {
    pub fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self {
        Self {
            session: EndpointSession::new(transport, provider, auth),
            sse_telemetry: None,
        }
    }

    pub fn with_telemetry(
        self,
        request: Option<Arc<dyn RequestTelemetry>>,
        sse: Option<Arc<dyn SseTelemetry>>,
    ) -> Self {
        Self {
            session: self.session.with_request_telemetry(request),
            sse_telemetry: sse,
        }
    }

    fn path() -> &'static str {
        "chat/completions"
    }

    /// Asks the server which models this key can use and returns the first one.
    async fn discover_model(&self) -> Result<String, ApiError> {
        let base_url = self.session.provider().base_url.clone();
        if let Some(model) = cached_model(&base_url) {
            return Ok(model);
        }
        let response = self
            .session
            .execute(Method::GET, "models", HeaderMap::new(), /*body*/ None)
            .await?;
        let listing: Value = serde_json::from_slice(&response.body).map_err(|err| {
            ApiError::Stream(format!(
                "failed to decode the model list from {base_url}: {err}"
            ))
        })?;
        let model = first_model_id(&listing).ok_or_else(|| ApiError::InvalidRequest {
            message: format!(
                "No models are available for this API key at {base_url}. Set `model` in \
                 ~/.ditfa/config.toml or pass `--model`."
            ),
        })?;
        remember_model(&base_url, &model);
        Ok(model)
    }

    #[instrument(
        name = "chat_completions.stream_request",
        level = "info",
        skip_all,
        fields(
            transport = "chat_completions_http",
            http.method = "POST",
            api.path = "chat/completions"
        )
    )]
    pub async fn stream_request(
        &self,
        mut request: ResponsesApiRequest,
        options: ChatCompletionsOptions,
    ) -> Result<ResponseStream, ApiError> {
        let ChatCompletionsOptions {
            session_id,
            thread_id,
            extra_headers,
        } = options;
        let mut headers = extra_headers;
        if let Some(ref thread_id) = thread_id {
            insert_header(&mut headers, "x-client-request-id", thread_id);
        }
        headers.extend(build_session_headers(session_id, thread_id));

        let requested_model = request.model.clone();
        let base_url = self.session.provider().base_url.clone();
        let substitute_key = format!("{base_url}#{requested_model}");
        if requested_model.eq_ignore_ascii_case(AUTO_MODEL) {
            request.model = self.discover_model().await?;
        } else if let Some(substitute) = cached_model(&substitute_key) {
            request.model = substitute;
        }

        match self.stream_once(&request, headers.clone()).await {
            Err(err) if request.model == requested_model && is_model_not_found(&err) => {
                let fallback = self.discover_model().await?;
                if fallback == requested_model {
                    return Err(err);
                }
                warn!(
                    "model `{requested_model}` is not available from this provider; using `{fallback}` instead"
                );
                remember_model(&substitute_key, &fallback);
                request.model = fallback;
                self.stream_once(&request, headers).await
            }
            result => result,
        }
    }

    async fn stream_once(
        &self,
        request: &ResponsesApiRequest,
        headers: HeaderMap,
    ) -> Result<ResponseStream, ApiError> {
        let (body, tool_map) = build_chat_request(request)?;
        let body = EncodedJsonBody::encode(&body)
            .map_err(|e| ApiError::Stream(format!("failed to encode chat request: {e}")))?;
        let stream_response = self
            .session
            .stream_encoded_json_with(Method::POST, Self::path(), headers, Some(body), |req| {
                req.headers.insert(
                    http::header::ACCEPT,
                    HeaderValue::from_static("text/event-stream"),
                );
            })
            .await?;
        Ok(spawn_chat_stream(
            stream_response,
            tool_map,
            self.session.provider().stream_idle_timeout,
            self.sse_telemetry.clone(),
        ))
    }
}
