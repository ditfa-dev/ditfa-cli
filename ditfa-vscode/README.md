# Ditfa Code for VS Code

An AI coding agent that reads, writes, and runs code in your workspace, and shows its work.

For VS Code and editors built on it, such as Cursor, Windsurf, and VSCodium.

---

## Why Ditfa Code

- **Works in one click.** No CLI to install first: the panel downloads its engine, checks it against the published SHA-256, and connects. Remote-SSH and WSL windows install on the remote side.
- **Any model, no account required.** Sign in with Ditfa, bring a key for OpenAI, Anthropic, Gemini, OpenRouter, or DeepSeek, or point it at Ollama or LM Studio. Keys live in your system keychain.
- **Tab autocomplete, off until you say so.** Suggestions appear as grey text and <kbd>Tab</kbd> accepts them, from the provider and model you choose, including a local one. Nothing is sent until you turn it on, and files that look like secrets are never used.
- **You see every change before it lands, and keep only the parts you want.** Edits appear as a diff inside the approval card with a checkbox on every hunk, and open in the native diff editor. After an edit lands each hunk has its own Undo, and the agent is told what you took back so it does not put it back.
- **Undo without Git.** Every message is a checkpoint: restore it to revert the agent's file changes and rewind the conversation. Effects of commands, such as installed packages, are not undone, and the panel says so.
- **Plan mode the agent cannot talk its way out of.** Read-only is enforced by the engine's sandbox, not by a prompt.
- **Survives everything.** Conversations come back after a reload, with their commands and diffs. If the engine crashes it restarts and resumes. Stop always stops: a turn that ignores it loses its engine.
- **Light on your machine.** The panel is under 50 KB of script with no framework, streaming is batched, long threads render only what is on screen, and the engine starts when you open the panel, not with the editor.
- **No surprises on cost.** A context meter, tokens and the real model under every turn, and an optional hard limit per turn. An agent stuck repeating a command is stopped.

---

## Getting started

1. Open **Ditfa Code** in the activity bar, or press <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd>.
2. Choose how to reach a model.
3. Ask for something. Use `@` to attach files and `/` for commands and skills.

If you already have the CLI, the extension uses it. It looks at `ditfa.executablePath`, your `PATH`, the usual install locations, and then its own managed copy. On a machine with no access to GitHub, copy the binary from a [release](https://github.com/ditfa-dev/ditfa-cli/releases) and use **Ditfa: Locate ditfa Binary…**.

Something wrong? **Ditfa: Run Diagnostics** writes a report you can read and share. It never includes key values.

---

## Tab autocomplete

Run **Ditfa: Set Up Tab Autocomplete…** (or click the `Tab` item in the status bar). You pick a provider, add a key if it needs one, and pick a model. Choose a small, fast one: a suggestion should arrive in about a second, and the chat model is usually too slow and too costly for this.

- Suggestions use the code before and after your cursor, plus short excerpts of your other open files. Turn the excerpts off with `ditfa.completion.contextFiles`.
- With code after the cursor on the same line, a suggestion never runs past the line.
- Local code models such as Qwen2.5-Coder or DeepSeek-Coder on Ollama use fill-in-the-middle. Everything else goes through chat completions, so any provider works.
- It calls the provider's API directly, with a key stored in your system keychain. For a Ditfa account that means an API key from chat.ditfa.com/api-keys; the browser sign-in is for the agent only.
- After three failures in a row it pauses for a minute instead of hammering a provider that is down.

Files such as `.env`, `.npmrc`, SSH keys and `*.pem` are never sent, and never get suggestions.

---

## Reviewing changes

When the agent proposes an edit with several hunks, each hunk has a checkbox. The engine takes a patch as a whole, so the unticked hunks are taken back out the moment the patch lands, through the editor, so <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> undoes it.

After an edit has landed, open **N changes** under a file to undo any hunk on its own, or the whole file. Hunks are found by their content, so this keeps working after other edits have moved the lines. If you edited the same lines since, that hunk is left alone and you are told. Restoring a checkpoint later skips what you already undid.

---

## Modes

| Mode | Sandbox | The agent asks |
| --- | --- | --- |
| Plan | Read-only | Never; writing is blocked |
| Ask first | Workspace | Before every edit and command |
| Auto | Workspace | Only to step outside the workspace |
| Full access | None | Never. Disposable machines only |

Modes and models apply to your next message, in the same conversation. Changing provider starts a new one. With no folder open, Ditfa stays read-only.

---

## Providers

Custom providers live in `~/.ditfa/config.toml` and appear in the provider picker next to the built-in ones:

```toml
model_provider = "my-provider"
model = "my-model"

[model_providers.my-provider]
name = "My Provider"
base_url = "https://api.example.com/v1"
env_key = "MY_PROVIDER_API_KEY"
```

The model menu lists what your key can actually use, fetched from the provider. Type any id into it for a model it does not list.

---

## Commands

| Command | Default keybinding |
| --- | --- |
| Ditfa: Open Chat | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> |
| Ditfa: Add Selection to Chat | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd> |
| Ditfa: Edit Selection… | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> |
| Fix with Ditfa | Lightbulb menu on any error or warning |
| Ditfa: Fix Terminal Output | Terminal context menu |
| Ditfa: Add File to Chat | Explorer context menu |
| Ditfa: Explain Selection | Editor context menu |
| Ditfa: Set Up Tab Autocomplete… | Or click `Tab` in the status bar |
| Ditfa: Turn Tab Autocomplete On or Off | — |
| Ditfa: Review Uncommitted Changes | — |
| Ditfa: New Conversation / Stop Current Turn | — |
| Ditfa: Select Provider… / Sign In / Sign Out | — |
| Ditfa: Run Diagnostics / Show Logs / Restart Engine | — |

---

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ditfa.executablePath` | `""` | Absolute path to `ditfa`; empty auto-detects |
| `ditfa.ditfaHome` | `""` | Override `DITFA_HOME` (default `~/.ditfa`) |
| `ditfa.provider` | `""` | Provider id |
| `ditfa.model` | `""` | Model id; empty uses the provider default |
| `ditfa.reasoningEffort` | `""` | `minimal` … `xhigh` for models that support it |
| `ditfa.approvalPolicy` | `on-request` | Set by the mode menu |
| `ditfa.sandboxMode` | `workspace-write` | Set by the mode menu |
| `ditfa.allowNetwork` | `false` | Let sandboxed commands reach the network |
| `ditfa.maxTokensPerTurn` | `0` | Stop a turn past this many tokens; `0` is off |
| `ditfa.completion.enabled` | `false` | Tab autocomplete; sends code around the cursor to your provider |
| `ditfa.completion.provider` | `""` | Provider for Tab; empty follows the chat provider |
| `ditfa.completion.model` | `""` | A small, fast model for Tab |
| `ditfa.completion.debounceMs` | `300` | Pause after typing before asking |
| `ditfa.completion.maxTokens` | `128` | Longest suggestion, in tokens |
| `ditfa.completion.multiline` | `true` | Allow multi-line suggestions |
| `ditfa.completion.contextFiles` | `true` | Include excerpts of other open files |
| `ditfa.completion.disabledLanguages` | `["plaintext", "scminput", "git-commit"]` | Languages Tab stays quiet in |
| `ditfa.showReasoning` | `true` | Show reasoning summaries in the transcript |
| `ditfa.autoContext.activeFile` | `true` | Tell the agent which file you have open |
| `ditfa.logLevel` | `info` | Output-channel verbosity; `trace` logs raw protocol |
| `ditfa.env` | `{}` | Extra environment variables for the `ditfa` process |

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
DITFA_E2E_BINARY=$(which ditfa) pnpm test tests/e2e   # against the real engine
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

To package a VSIX:

```bash
pnpm run package
```

---

## Privacy

Analytics are **off** by default; the extension does not pass `--analytics-default-enabled` to the server. Opt in via `[analytics] enabled = true` in `config.toml` if you want them.

Prompts and file contents go to whichever provider you configure. Tab autocomplete is off until you turn it on, and then sends the code around your cursor, and short excerpts of other open files, to the provider you chose for it. Local providers (Ollama, LM Studio) keep everything on your machine.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../NOTICE).
