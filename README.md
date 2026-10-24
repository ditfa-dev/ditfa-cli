# Ditfa CLI

**Ditfa CLI** is an AI coding agent for your terminal. It reads your code, edits files,
runs commands in a sandbox, and asks before it does anything risky — with the model of
your choice: Ditfa, OpenAI, Anthropic Claude, Google Gemini, OpenRouter, DeepSeek, or a
local model through Ollama, LM Studio, or vLLM.

[![CI](https://github.com/ditfa-dev/ditfa-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ditfa-dev/ditfa-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ditfa-dev/ditfa-cli)](https://github.com/ditfa-dev/ditfa-cli/releases/latest)

## Install

**macOS and Linux**

```shell
curl -fsSL https://github.com/ditfa-dev/ditfa-cli/releases/latest/download/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://github.com/ditfa-dev/ditfa-cli/releases/latest/download/install.ps1 | iex
```

**npm**

```shell
npm install -g ditfa
```

Prefer a manual download? Every [release](https://github.com/ditfa-dev/ditfa-cli/releases/latest)
has archives for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and Windows
(x64 and arm64), plus a `SHA256SUMS` file. The installers verify the checksum before
installing.

## Quick start

1. Create an API key at [chat.ditfa.com/api-keys](https://chat.ditfa.com/api-keys).
2. Run Ditfa in your project:

```shell
export DITFA_API_KEY=dt-...
cd my-project
ditfa
```

With a Ditfa key set, no configuration is needed: Ditfa picks the best model your plan
includes. Run a one-off task without the interactive UI:

```shell
ditfa exec "add unit tests for the parser and make them pass"
```

## Use any model

```shell
# OpenAI
export OPENAI_API_KEY=sk-...
ditfa -m gpt-5.5

# Anthropic, Gemini, OpenRouter, DeepSeek
ditfa -c model_provider=anthropic -m claude-sonnet-4-5
ditfa -c model_provider=gemini -m gemini-2.5-pro
ditfa -c model_provider=openrouter -m qwen/qwen3-coder

# Local models
ditfa --oss --local-provider ollama
```

Set a default in `~/.ditfa/config.toml`:

```toml
model_provider = "anthropic"
model = "claude-sonnet-4-5"
```

Any OpenAI-compatible server can be added in a few lines. See
[PROVIDERS.md](./PROVIDERS.md) for the full list, custom providers and how the
translation layer works.

## What it does

- **Edits and runs code locally** — file edits as reviewable patches, commands in a
  sandbox (Seatbelt on macOS, Landlock/bubblewrap on Linux, a restricted token on
  Windows).
- **Approvals you control** — from "ask before every command" to fully autonomous,
  per project.
- **Sessions that persist** — resume any conversation with `ditfa resume`; long
  sessions are compacted automatically.
- **MCP** — connect Model Context Protocol servers, or run Ditfa itself as an MCP server.
- **Skills and AGENTS.md** — project instructions and reusable workflows the agent
  follows.
- **Scriptable** — `ditfa exec` with JSON output and `--output-schema` for CI and
  automations.
- **VS Code** — the extension in [`ditfa-vscode/`](./ditfa-vscode) drives the same agent.

## Configuration

| Variable              | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `DITFA_API_KEY`       | Ditfa API key; makes Ditfa the default provider      |
| `DITFA_HOME`          | Config and session directory (default `~/.ditfa`)    |
| `OPENAI_API_KEY`      | OpenAI                                               |
| `ANTHROPIC_API_KEY`   | Anthropic                                            |
| `GEMINI_API_KEY`      | Google Gemini                                        |
| `OPENROUTER_API_KEY`  | OpenRouter                                           |
| `DEEPSEEK_API_KEY`    | DeepSeek                                             |
| `DITFA_OSS_BASE_URL`  | Base URL of a local Ollama or LM Studio server       |

More in [docs/config.md](./docs/config.md), [docs/sandbox.md](./docs/sandbox.md) and
[docs/getting-started.md](./docs/getting-started.md).

## Build from source

Requires Rust (the toolchain in `ditfa-rs/rust-toolchain.toml` is installed
automatically by rustup).

```shell
git clone https://github.com/ditfa-dev/ditfa-cli.git
cd ditfa-cli/ditfa-rs
cargo build --release --bin ditfa
./target/release/ditfa --version
```

On a laptop, `cargo build -j 2` keeps the machine responsive while it compiles.

## Repository layout

| Path                              | Contents                                               |
| --------------------------------- | ------------------------------------------------------ |
| [`ditfa-rs/`](./ditfa-rs)         | Rust workspace: agent core, TUI, sandboxing, providers |
| [`ditfa-cli/`](./ditfa-cli)       | npm launcher for the native binary                     |
| [`ditfa-vscode/`](./ditfa-vscode) | VS Code extension                                      |
| [`sdk/`](./sdk)                   | TypeScript and Python SDKs                             |
| [`docs/`](./docs)                 | User documentation                                     |
| [`scripts/install/`](./scripts/install) | Install scripts published with each release      |

## Releasing

Push a tag such as `v0.2.0`. The [release workflow](./.github/workflows/release.yml)
builds all six platforms, publishes the GitHub Release with checksums and the install
scripts, and publishes to npm when the `NPM_TOKEN` secret is configured.

## License

Apache-2.0. Ditfa CLI is a derivative of an Apache-2.0 project by OpenAI; see [LICENSE](./LICENSE) and
[NOTICE](./NOTICE).
