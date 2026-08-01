# Ditfa Code — Multi-Provider AI Coding Agent

<p align="center">
  <strong>Ditfa Code</strong> is an open-source coding agent that reads, writes, and runs code on your machine — connected to OpenAI, Anthropic Claude, Google Gemini, or local models via Ollama, LM Studio, or vLLM.
</p>

<p align="center">
  Use it <strong>in your terminal</strong> with <code>ditfa</code>, or <strong>inside VS Code</strong> with the official extension.
</p>

---

## Features

- 🌐 **Multi-Provider Support** — connect to OpenAI, Anthropic Claude, Google Gemini, or local models.
- ⚡ **Local Tool Execution** — sandboxed command execution, file manipulation, and git workflows.
- 🛡️ **Interactive Approvals** — configurable security policies and prompts before anything runs.
- 💾 **Session Persistence** — persistent threads, history management, and context compression.
- 🦙 **Local LLM First-Class** — built-in support for Ollama (`http://localhost:11434/v1`) and LM Studio (`http://localhost:1234/v1`).
- 🧩 **Two surfaces, one agent** — the terminal and the VS Code extension drive the same Rust core over the same protocol.

---

## Install

### Terminal

```shell
npm install -g ditfa
```

Then run it:

```shell
ditfa "explain the repository structure"
```

### VS Code

Install **Ditfa Code** from the Marketplace, or from the command line:

```shell
code --install-extension ditfa.ditfa-code
```

The extension needs the `ditfa` binary. Platform-specific builds bundle it; otherwise install it with `npm i -g ditfa` or point `ditfa.executablePath` at your own build.

### Build from source

```shell
git clone https://github.com/Teamtem-dev/ditfa-code.git
cd ditfa-code

cargo build --release --manifest-path ditfa-rs/Cargo.toml --bin ditfa

# Binary output:
./ditfa-rs/target/release/ditfa
```

---

## Usage

```shell
# Run with the configured default provider
ditfa "explain the repository structure"

# Switch provider and model via CLI flags
ditfa --provider anthropic --model claude-3-5-sonnet "refactor src/main.rs"
ditfa --provider gemini --model gemini-1.5-pro "add unit tests for parser"
ditfa --provider ollama --model llama3 "summarize recent commits"
```

---

## Provider Configuration Guide

Ditfa Code reads configuration from `~/.ditfa/config.toml`. You can configure API keys, custom base URLs, and default providers. Both the terminal and the VS Code extension read the same file.

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

## Repository layout

| Path | What it is |
|---|---|
| [`ditfa-rs/`](./ditfa-rs) | The Rust workspace — agent core, app-server, sandboxing, provider adapters |
| [`ditfa-cli/`](./ditfa-cli) | npm launcher that ships the `ditfa` binary (published as `ditfa`) |
| [`ditfa-vscode/`](./ditfa-vscode) | VS Code extension (published as `ditfa.ditfa-code`) |
| [`sdk/`](./sdk) | TypeScript and Python SDKs |
| [`docs/`](./docs) | Configuration, sandboxing, and usage documentation |

---

## Architecture & Adding Providers

See [PROVIDERS.md](./PROVIDERS.md) for a guide on how provider adapters are implemented and how to add a new provider to Ditfa Code.

---

## Credits & Attribution

Ditfa Code is derived from [openai/ditfa](https://github.com/openai/codex), licensed under the Apache License 2.0.

- Original Copyright (c) OpenAI.
- Preserved `LICENSE` and `NOTICE` files are retained in the project root.
