# Ditfa Code for VS Code

A multi-provider AI coding agent that reads, writes, and runs code in your workspace — with every command and file edit shown to you before it happens.

Ditfa Code connects to **OpenAI, Anthropic, Google Gemini, or local models** running under Ollama, LM Studio, or vLLM. Provider choice is a setting, not a rewrite.

---

## Features

- **Chat sidebar** with streaming responses, reasoning summaries, and live plan tracking
- **Command execution** with output streamed into the transcript, and approval before anything runs
- **File edits** shown in VS Code's native side-by-side diff, approved per patch
- **Any provider** — switch between OpenAI, Anthropic, Gemini, and local endpoints from a picker
- **Subscription or API key** — sign in with a Ditfa subscription, a device code, or your own provider key
- **Sandbox control** — read-only, workspace-write, or full access, chosen explicitly
- **Context awareness** — attach files with `@`, or send the current editor selection
- **Thread history** — resume any previous conversation in this workspace

---

## Requirements

The extension drives the `ditfa` binary; it does not bundle a model runtime.

Install the CLI one of these ways:

```bash
npm install -g ditfa
```

or build it from this repository:

```bash
cargo build --release --manifest-path ditfa-rs/Cargo.toml --bin ditfa
```

The extension finds the binary in this order:

1. The `ditfa.executablePath` setting
2. A binary bundled in a platform-specific VSIX
3. `ditfa` on your `PATH`
4. A Cargo build inside the open workspace (`ditfa-rs/target/release`, then `debug`)

If none of those resolve, the chat panel says so and offers to locate the binary for you.

---

## Getting started

1. Open the **Ditfa Code** view in the activity bar (or press <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>).
2. Click the account chip and sign in, or configure a provider key in `~/.ditfa/config.toml`.
3. Ask for something. Attach files with `@`.

---

## Configuring providers

Providers live in `~/.ditfa/config.toml`. The extension reads them and shows every one it finds in the provider picker, alongside the built-in adapters.

```toml
default_provider = "anthropic"
default_model = "claude-3-5-sonnet"

[model_providers.anthropic]
name = "Anthropic"
env_key = "ANTHROPIC_API_KEY"

[model_providers.ollama]
name = "Ollama (local)"
base_url = "http://localhost:11434/v1"

[model_providers.my-provider]
name = "My Custom Provider"
base_url = "https://api.example.com/v1"
env_key = "MY_PROVIDER_API_KEY"
adapter = "my-provider"
```

Run **Ditfa: Select Model…** to pick a provider and model. For local models whose catalog cannot be enumerated, the picker accepts a typed model name.

Keys belong in `config.toml` or your shell environment. The `ditfa.env` setting can pass extra variables to the server process, but it is stored in plain text in your VS Code settings — prefer `config.toml`.

---

## Approvals and the sandbox

Every command and every patch is shown before it is applied. Run **Ditfa: Select Approval Mode…** to choose:

| Mode | Sandbox | Prompts |
| --- | --- | --- |
| Read only | `read-only` | The agent can read and plan, nothing else |
| Approve on request | `workspace-write` | Only when the agent needs to leave the sandbox |
| Approve everything | `workspace-write` | Before every command |
| Full access | none | Never — use only in a container or a disposable workspace |

Full access asks for explicit confirmation before it is enabled.

---

## Commands

| Command | Default keybinding |
| --- | --- |
| Ditfa: Open Chat | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> |
| Ditfa: Add Selection to Chat | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> |
| Ditfa: New Thread | — |
| Ditfa: Resume Thread… | — |
| Ditfa: Interrupt Current Turn | — |
| Ditfa: Select Model… / Select Provider… | — |
| Ditfa: Select Approval Mode… | — |
| Ditfa: Sign In / Sign Out / Show Account & Usage | — |
| Ditfa: Explain Selection | — |
| Ditfa: Review Uncommitted Changes | — |
| Ditfa: Open Ditfa in Terminal | — |
| Ditfa: Restart Ditfa Server | — |
| Ditfa: Show Logs | — |

---

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ditfa.executablePath` | `""` | Absolute path to `ditfa`; empty auto-detects |
| `ditfa.ditfaHome` | `""` | Override `DITFA_HOME` (default `~/.ditfa`) |
| `ditfa.provider` | `""` | Provider id from `config.toml` |
| `ditfa.model` | `""` | Model id; empty uses the provider default |
| `ditfa.reasoningEffort` | `""` | `minimal` … `xhigh` for models that support it |
| `ditfa.approvalPolicy` | `on-request` | When to ask before running commands |
| `ditfa.sandboxMode` | `workspace-write` | Sandbox applied to agent commands |
| `ditfa.showReasoning` | `true` | Show reasoning summaries in the transcript |
| `ditfa.autoContext.activeFile` | `true` | Attach the active file path with each message |
| `ditfa.logLevel` | `info` | Output-channel verbosity; `trace` logs raw protocol |
| `ditfa.env` | `{}` | Extra environment variables for the `ditfa` process |

Provider, model, and sandbox changes apply to the **next** thread; the extension offers to start one.

---

## How it works

```
VS Code extension host
        │  JSON-RPC 2.0 over stdio (newline-delimited JSON)
        ▼
  ditfa app-server            ← ditfa-rs/app-server
        │
        ▼
  ditfa core agent  ──►  provider adapters  ──►  OpenAI / Anthropic / Gemini / local
```

The extension is a thin client. It spawns `ditfa app-server --listen stdio://`, completes the `initialize` handshake, and drives threads and turns over the same protocol the CLI and TUI use. All agent logic, sandboxing, and provider translation stay in Rust.

Protocol types in `src/protocol/generated/` are mirrored from `ditfa-rs/app-server-protocol/schema/typescript`, so the client type-checks against the exact wire contract. Regenerate with:

```bash
cargo test -p ditfa-app-server-protocol && pnpm run sync-protocol
```

---

## Development

```bash
pnpm install
pnpm run build      # sync protocol types, then bundle
pnpm run watch      # rebuild on change
pnpm run typecheck
pnpm test
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

To package a VSIX:

```bash
pnpm run package
```

---

## Privacy

Analytics are **off** by default; the extension does not pass `--analytics-default-enabled` to the server. Opt in via `[analytics] enabled = true` in `config.toml` if you want them.

Prompts and file contents go to whichever provider you configure. Local providers (Ollama, LM Studio, vLLM) keep everything on your machine.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../NOTICE).
