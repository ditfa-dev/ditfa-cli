# Ditfa CLI — Multi-Provider AI Coding CLI Agent

<p align="center">
  <strong>Ditfa</strong> is an open-source, multi-provider terminal coding agent that connects to multiple LLM providers (OpenAI, Anthropic Claude, Google Gemini, and local models via Ollama, LM Studio, or vLLM).
</p>

---

## Features

- 🌐 **Multi-Provider Support**: Connect seamlessly to OpenAI, Anthropic Claude, Google Gemini, or local models.
- ⚡ **Local Tool Execution**: Automated, sandboxed command execution, file manipulation, and git workflows.
- 🛡️ **Interactive Approvals**: Configurable security policies and approval prompts before running terminal commands.
- 💾 **Session Persistence**: Persistent conversation threads, history management, and context window compression.
- 🦙 **Local LLM First-Class Integration**: Built-in support for Ollama and LM Studio endpoints (`http://localhost:11434/v1` and `http://localhost:1234/v1`).

---

## Quickstart

### Building from Source

Build Ditfa using Rust & Cargo (or Bun for scripts):

```shell
# Clone the repository
git clone https://github.com/Foshati/arlenta.git
cd arlenta/ditfa-code

# Build release binary
cargo build --release --manifest-path codex-rs/Cargo.toml

# Binary output will be at:
./codex-rs/target/release/ditfa
```

### Running Ditfa

```shell
# Run with default provider (OpenAI)
ditfa "explain the repository structure"

# Switch provider and model via CLI flags
ditfa --provider anthropic --model claude-3-5-sonnet "refactor src/main.rs"
ditfa --provider gemini --model gemini-1.5-pro "add unit tests for parser"
ditfa --provider ollama --model llama3 "summarize recent commits"
```

---

## Provider Configuration Guide

Ditfa reads configuration from `~/.ditfa/config.toml`. You can configure API keys, custom base URLs, and default providers.

### Configuration File (`~/.ditfa/config.toml`) Example

```toml
# Set the default provider and model
default_provider = "anthropic"
default_model = "claude-3-5-sonnet"

[model_providers.openai]
name = "OpenAI"
env_key = "OPENAI_API_KEY"

[model_providers.anthropic]
name = "Anthropic"
base_url = "https://api.anthropic.com/v1"
env_key = "ANTHROPIC_API_KEY"
adapter = "anthropic"

[model_providers.gemini]
name = "Google Gemini"
base_url = "https://generativelanguage.googleapis.com"
env_key = "GEMINI_API_KEY"
adapter = "gemini"

[model_providers.ollama]
name = "Ollama (Local)"
base_url = "http://localhost:11434/v1"
requires_openai_auth = false

[model_providers.vllm]
name = "vLLM Self-Hosted"
base_url = "http://localhost:8000/v1"
adapter = "chat-completions"
requires_openai_auth = false
```

### Environment Variables

| Variable | Description |
|---|---|
| `DITFA_HOME` | Configuration & session directory (defaults to `~/.ditfa`) |
| `DITFA_API_KEY` | Default API key override for primary provider |
| `ANTHROPIC_API_KEY` | API key for Anthropic provider |
| `GEMINI_API_KEY` | API key for Google Gemini provider |
| `OPENAI_API_KEY` | API key for OpenAI provider |
| `DITFA_OSS_PORT` | Custom port override for local Ollama/LM Studio servers |

---

## Architecture & Adding Providers

See [PROVIDERS.md](./PROVIDERS.md) for a guide on how provider adapters are implemented and how to add a new provider to Ditfa.

---

## Credits & Attribution

Ditfa is derived from [openai/codex](https://github.com/openai/codex), licensed under the Apache License 2.0.

- Original Copyright (c) OpenAI.
- Preserved `LICENSE` and `NOTICE` files are retained in the project root.
