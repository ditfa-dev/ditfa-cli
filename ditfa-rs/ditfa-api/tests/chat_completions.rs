use std::sync::Arc;
use std::time::Duration;

use ditfa_api::AuthProvider;
use ditfa_api::ChatCompletionsClient;
use ditfa_api::ChatCompletionsOptions;
use ditfa_api::Provider;
use ditfa_api::ResponseEvent;
use ditfa_api::ResponsesApiRequest;
use ditfa_api::RetryConfig;
use ditfa_client::ReqwestTransport;
use ditfa_protocol::models::ContentItem;
use ditfa_protocol::models::ResponseItem;
use futures::StreamExt;
use http::HeaderMap;
use http::HeaderValue;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

#[derive(Clone)]
struct BearerAuth;

impl AuthProvider for BearerAuth {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        headers.insert(
            http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer dt-test"),
        );
    }
}

fn provider(base_url: &str) -> Provider {
    Provider {
        name: "Ditfa".to_string(),
        base_url: base_url.to_string(),
        query_params: None,
        headers: HeaderMap::new(),
        retry: RetryConfig {
            max_attempts: 1,
            base_delay: Duration::from_millis(1),
            retry_429: false,
            retry_5xx: false,
            retry_transport: false,
        },
        stream_idle_timeout: Duration::from_secs(5),
    }
}

fn request(model: &str) -> ResponsesApiRequest {
    ResponsesApiRequest {
        model: model.into(),
        instructions: "Be brief.".into(),
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".into(),
            content: vec![ContentItem::InputText { text: "hi".into() }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        tools: None,
        tool_choice: "auto".into(),
        parallel_tool_calls: false,
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

fn sse_body(text: &str) -> String {
    let chunk = json!({
        "id": "chatcmpl-test",
        "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": "stop" }],
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}

fn sse_response(text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(sse_body(text))
}

fn models_response() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "object": "list",
        "data": [
            { "id": "ditfa-pro", "object": "model", "owned_by": "ditfa" },
            { "id": "ditfa-lite", "object": "model", "owned_by": "ditfa" },
        ],
    }))
}

async fn collect_text(client: &ChatCompletionsClient<ReqwestTransport>, model: &str) -> String {
    let mut stream = client
        .stream_request(request(model), ChatCompletionsOptions::default())
        .await
        .expect("stream should start");
    let mut text = String::new();
    let mut completed = false;
    while let Some(event) = stream.next().await {
        match event.expect("stream event") {
            ResponseEvent::OutputTextDelta(delta) => text.push_str(&delta),
            ResponseEvent::Completed { .. } => completed = true,
            _ => {}
        }
    }
    assert!(completed, "stream should complete");
    text
}

fn body_of(request: &Request) -> Value {
    serde_json::from_slice(&request.body).expect("json body")
}

#[tokio::test]
async fn streams_from_chat_completions_with_auth() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/chat/completions"))
        .and(header("authorization", "Bearer dt-test"))
        .respond_with(sse_response("Hello from Ditfa"))
        .expect(1)
        .mount(&server)
        .await;

    let base_url = format!("{}/api/v1", server.uri());
    let client = ChatCompletionsClient::new(
        ReqwestTransport::new(reqwest::Client::new()),
        provider(&base_url),
        Arc::new(BearerAuth),
    );
    assert_eq!(collect_text(&client, "ditfa-pro").await, "Hello from Ditfa");

    let received = server.received_requests().await.expect("requests");
    let body = body_of(&received[0]);
    assert_eq!(body["model"], "ditfa-pro");
    assert_eq!(body["stream"], true);
    assert_eq!(
        body["messages"],
        json!([
            { "role": "system", "content": "Be brief." },
            { "role": "user", "content": "hi" },
        ])
    );
}

#[tokio::test]
async fn auto_model_uses_first_listed_model() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/auto/v1/models"))
        .respond_with(models_response())
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/auto/v1/chat/completions"))
        .respond_with(sse_response("ok"))
        .mount(&server)
        .await;

    let base_url = format!("{}/auto/v1", server.uri());
    let client = ChatCompletionsClient::new(
        ReqwestTransport::new(reqwest::Client::new()),
        provider(&base_url),
        Arc::new(BearerAuth),
    );
    // The second turn reuses the discovered model instead of listing again.
    assert_eq!(collect_text(&client, "auto").await, "ok");
    assert_eq!(collect_text(&client, "auto").await, "ok");

    let received = server.received_requests().await.expect("requests");
    let models: Vec<Value> = received
        .iter()
        .filter(|request| request.url.path().ends_with("/chat/completions"))
        .map(|request| body_of(request)["model"].clone())
        .collect();
    assert_eq!(models, vec![json!("ditfa-pro"), json!("ditfa-pro")]);
}

#[tokio::test]
async fn unknown_model_falls_back_to_an_available_one() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/fallback/v1/models"))
        .respond_with(models_response())
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/fallback/v1/chat/completions"))
        .respond_with(|request: &Request| {
            let body: Value = serde_json::from_slice(&request.body).expect("json body");
            if body["model"] == "gpt-5.5" {
                ResponseTemplate::new(404).set_body_json(json!({
                    "error": {
                        "message": "The model 'gpt-5.5' does not exist or is not available via the API.",
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    },
                }))
            } else {
                sse_response("fallback ok")
            }
        })
        .mount(&server)
        .await;

    let base_url = format!("{}/fallback/v1", server.uri());
    let client = ChatCompletionsClient::new(
        ReqwestTransport::new(reqwest::Client::new()),
        provider(&base_url),
        Arc::new(BearerAuth),
    );
    assert_eq!(collect_text(&client, "gpt-5.5").await, "fallback ok");
    // Remembered: the next turn goes straight to the substitute.
    assert_eq!(collect_text(&client, "gpt-5.5").await, "fallback ok");

    let received = server.received_requests().await.expect("requests");
    let completions = received
        .iter()
        .filter(|request| request.url.path().ends_with("/chat/completions"))
        .count();
    assert_eq!(completions, 3);
}
