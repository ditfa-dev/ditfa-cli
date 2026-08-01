# Adding a New Provider to Ditfa

This guide explains Ditfa's multi-provider architecture and provides a step-by-step tutorial on how to implement a new `ProviderAdapter` for a custom LLM provider or local endpoint.

---

## 1. Multi-Provider Architecture

Ditfa uses a **Translation Adapter Pattern** to support multiple model providers without modifying the core agent loop or context management:

```
+-------------------------------------------------------------+
|                     Ditfa Core Agent                        |
|   (Builds ResponsesApiRequest / Consumes ResponseEvent)     |
+-------------------------------------------------------------+
                              |
                              v
                 +--------------------------+
                 |     ProviderAdapter      |
                 |      Trait Interface     |
                 +--------------------------+
                   /          |         \
                  /           |          \
                 v            v           v
          +------------+ +----------+ +-------------+
          |  OpenAI    | |Anthropic | |   Gemini    |
          |  Adapter   | | Adapter  | |  Adapter    |
          +------------+ +----------+ +-------------+
                 |            |           |
                 v            v           v
           OpenAI API   Anthropic API  Gemini API
          (/v1/responses)(/v1/messages)(/v1beta/...)
```

- **Internal Data Model**: The agent core works with `ResponseItem` enum variants (`Message`, `FunctionCall`, `FunctionCallOutput`, `Reasoning`).
- **Adapter Responsibilities**:
  1. Translates `ResponsesApiRequest` (containing `ResponseItem` inputs) into the target provider's HTTP request JSON.
  2. Sends the HTTP request.
  3. Parses the streaming chunks into normalized `ResponseEvent` events (`OutputItemAdded`, `OutputTextDelta`, `Completed`, etc.).

---

## 2. Step-by-Step: Adding a New Provider Adapter

### Step 1: Create the Adapter File

Create a new file under `ditfa-rs/model-provider/src/adapter/my_provider.rs`:

```rust
use async_trait::async_trait;
use ditfa_api::ResponseEvent;
use ditfa_api::ResponsesApiRequest;
use futures::StreamExt;
use http::HeaderMap;

use super::AdapterCapabilities;
use super::AdapterError;
use super::ProviderAdapter;
use super::ResponseEventStream;

#[derive(Debug, Clone)]
pub struct MyProviderAdapter {
    pub base_url: String,
    pub client: reqwest::Client,
}

impl MyProviderAdapter {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    /// Translates Ditfa ResponseItems to MyProvider JSON format.
    pub fn translate_request(&self, request: &ResponsesApiRequest) -> serde_json::Value {
        // Build provider-specific JSON payload here
        serde_json::json!({
            "model": request.model,
            "prompt": request.instructions,
            "stream": request.stream
        })
    }
}

#[async_trait]
impl ProviderAdapter for MyProviderAdapter {
    fn provider_id(&self) -> &str {
        "my-provider"
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
            max_context_tokens: Some(128_000),
        }
    }

    async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        auth_headers: HeaderMap,
    ) -> Result<ResponseEventStream, AdapterError> {
        let url = format!("{}/v1/chat", self.base_url.trim_end_matches('/'));
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
                "MyProvider API error HTTP {status}: {text}"
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
```

---

### Step 2: Export in `adapter/mod.rs`

In `ditfa-rs/model-provider/src/adapter/mod.rs`:

```rust
pub mod anthropic;
pub mod chat_completions;
pub mod gemini;
pub mod my_provider;
pub mod openai;
```

---

### Step 3: Register in Config & Test

Users can now reference your provider in `~/.ditfa/config.toml`:

```toml
[model_providers.my-provider]
name = "My Custom Provider"
base_url = "https://api.myprovider.com/v1"
env_key = "MY_PROVIDER_API_KEY"
adapter = "my-provider"
```

And test execution with:

```shell
ditfa --provider my-provider --model default "Hello Ditfa!"
```

---

## 3. Testing Your Provider

Add unit tests in `model-provider/src/adapter/tests.rs` to verify:
1. `translate_request` outputs valid JSON matching your API spec.
2. `capabilities()` accurately reflects supported features.
3. Stream chunk parsing properly maps to `ResponseEvent::OutputTextDelta` or `ResponseEvent::Completed`.
