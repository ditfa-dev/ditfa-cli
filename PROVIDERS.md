# Model providers

Ditfa CLI talks to models over one of two wire protocols:

| `wire_api`  | Endpoint                 | Used by                                                                                   |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `responses` | `POST /responses`        | OpenAI, Azure OpenAI, Amazon Bedrock, recent Ollama and LM Studio                          |
| `chat`      | `POST /chat/completions` | Ditfa, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, Together, vLLM, llama.cpp, … |

The agent core always works with the Responses data model. For `chat` providers,
`ditfa-rs/ditfa-api/src/chat.rs` translates each request into a Chat Completions
body and turns the streamed `chat.completion.chunk` frames back into Responses
events, so tools, approvals, sandboxing, history and compaction behave the same
on every provider.

## Built-in providers

| id           | Key variable         | Base URL                                                  |
| ------------ | -------------------- | --------------------------------------------------------- |
| `ditfa`      | `DITFA_API_KEY`      | `https://api.ditfa.com/api/v1`                            |
| `openai`     | `OPENAI_API_KEY` or `ditfa login --with-api-key` | `https://api.openai.com/v1`   |
| `anthropic`  | `ANTHROPIC_API_KEY`  | `https://api.anthropic.com/v1`                            |
| `gemini`     | `GEMINI_API_KEY`     | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1`                            |
| `deepseek`   | `DEEPSEEK_API_KEY`   | `https://api.deepseek.com/v1`                             |
| `ollama`     | none                 | `http://localhost:11434/v1`                               |
| `lmstudio`   | none                 | `http://localhost:1234/v1`                                |
| `amazon-bedrock` | AWS credentials  | regional Bedrock endpoint                                 |

When `model_provider` is not set and `DITFA_API_KEY` holds a Ditfa key (`dt-…`),
Ditfa is the default provider; otherwise OpenAI is.

Pick a provider per run or in `~/.ditfa/config.toml`:

```shell
ditfa -c model_provider=anthropic -m claude-sonnet-4-5
ditfa -c model_provider=gemini -m gemini-2.5-pro
ditfa --oss --local-provider ollama
```

```toml
model_provider = "openrouter"
model = "qwen/qwen3-coder"
```

### Choosing a model

`model = "auto"` (the default for Ditfa) asks the provider's `GET /models` for
the models your key can use and picks the first one. If a configured model does
not exist on a `chat` provider, Ditfa falls back to the first available model
for the rest of the session and logs a warning instead of failing the turn.

## Adding your own provider

Any OpenAI-compatible server works. Add it under `model_providers`:

```toml
model_provider = "together"
model = "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8"

[model_providers.together]
name = "Together AI"
base_url = "https://api.together.xyz/v1"
env_key = "TOGETHER_API_KEY"
wire_api = "chat"
```

Optional fields: `http_headers`, `env_http_headers`, `query_params`,
`request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms`. A
definition with the same id as one of the hosted presets above (`ditfa`,
`anthropic`, `gemini`, `openrouter`, `deepseek`) replaces the preset, which is
how you route one of them through a proxy.

## What the translation covers

- System instructions and developer messages become one leading `system` message.
- Function tools, freeform tools (exposed as a function with a single `input`
  string) and namespaced MCP tools (`<namespace>__<tool>`) round-trip by name.
- Parallel tool calls, streamed tool arguments, calls without `index` or `id`.
- Reasoning streamed as `reasoning_content` or `reasoning` (DeepSeek, Qwen,
  OpenRouter, vLLM, Ollama).
- Images in user messages and in tool results.
- Token usage, including cached and reasoning tokens.
- Structured output (`--output-schema`) as `response_format: json_schema`.
- Errors: context-window, quota and rate-limit failures map to the same handling
  as on the Responses API.

Hosted Responses-only tools (built-in web search, image generation) are not sent
to `chat` providers.
