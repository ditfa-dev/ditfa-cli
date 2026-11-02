# Changelog

All notable changes to the Ditfa extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] — 2026-11-02

### Changed

- Reuse the canonical desktop app icon unchanged for the Marketplace tile.
- Use **Ditfa** consistently in the extension listing, panel, status bar, diagnostics, and release notes. The extension identifier remains `ditfa.ditfa-code` so existing installations receive updates.

## [0.3.0] — 2026-11-02

### Added

- **Tab autocomplete.** Inline suggestions accepted with <kbd>Tab</kbd>, from any provider Ditfa supports or a local model. Local code models use fill-in-the-middle; everything else uses chat completions. Off until you set it up and turn it on; never uses files that look like secrets; pauses after repeated failures.
- **Choose hunks before an edit lands.** Every hunk of a multi-hunk edit has a checkbox in the approval card; unticked hunks are taken back out as soon as the patch is applied.
- **Undo any hunk, or a whole file, after an edit.** Hunks are located by content, so it still works after other edits moved the lines. The agent is told what you took back.
- Status-bar item for Tab autocomplete, and **Ditfa: Set Up Tab Autocomplete…**.

### Changed

- Restoring a checkpoint, the diff editor, and the turn review all account for hunks you already undid.

## [0.2.0] — 2026-11-01

A rebuild of the panel and the layer under it.

### Added

- One-click engine install with SHA-256 verification, and diagnostics.
- Setup with no CLI and no account: Ditfa sign-in, API keys in the system keychain, or local models.
- Checkpoints: restore any message to revert file changes and rewind, without Git.
- Plan, Ask first, Auto, and Full access modes, applied per message and enforced by the sandbox.
- Model menu in the panel, listing what the provider really offers.
- Conversation search, rename, and delete in the panel.
- `/` commands and skills, inline edit, Fix with Ditfa, Fix Terminal Output, pasted images.
- Inline diff preview in the approval card.
- Context meter, per-turn tokens and model, an optional token limit, and a loop guard.
- Conversations restored on reload, including commands and diffs.
- Automatic engine restart with the conversation resumed.
- New look built on the Ditfa mark and its motion.

### Fixed

- **Attached files never reached the model.** `mention` inputs are for plugins and are dropped by the core.
- **Sign-in used the wrong flow** for Ditfa accounts; it now runs `ditfa login`.
- **Every user message appeared twice.**
- **Click handlers stacked up** on each state update, so collapse toggles cancelled themselves, and the draft was wiped.
- **Context percentage used lifetime tokens**, reaching 100% far too early.
- **New and deleted files showed wrong stats and an empty diff**: they carry content, not a diff.
- **Provider model lists showed OpenAI models** for every provider.
- **A retried request added a card per attempt**, and a fatal error appeared twice.
- **An approval stayed on screen** after the turn was interrupted.
- **A server killed by a signal looked alive**, and MCP elicitation requests failed.
- **A hung or failing engine gave no reason.** Starting now times out and shows stderr.
- Writing to a dead server could crash the extension host (EPIPE).
- Picking a model failed with no folder open and dirtied `.vscode/settings.json` otherwise.
- `Cmd+Shift+D` no longer overrides Run and Debug.
- A window with no folder ran the agent against `/`.

### Changed

- The engine starts with the panel, not with the editor, and a missing engine no longer opens a modal on startup.
- Streaming updates are batched, and command output is capped.

## [0.1.0] — Unreleased

First release.

### Added

- Chat sidebar backed by `ditfa app-server` over JSON-RPC/stdio, with streaming
  agent messages, reasoning summaries, and live plan tracking.
- Command execution cards with streamed output, exit status, and duration.
- File change cards that open in VS Code's native diff editor, reconstructing the
  pre- or post-patch document from the unified diff.
- Inline approvals for command execution, file changes, permission escalation, and
  agent questions.
- Provider and model pickers sourced from `config.toml` and `model/list`, with
  free-text entry for catalogs the server cannot enumerate.
- Ditfa account support: browser sign-in, device-code sign-in, API key, sign-out,
  and a plan/rate-limit/usage report.
- Approval-mode picker covering read-only, workspace-write, and full-access
  sandboxes, with explicit confirmation before disabling the sandbox.
- Thread history: resume any previous thread scoped to the current workspace.
- `@`-mention file attachment backed by the server's fuzzy file search.
- Editor integration: add selection to chat, explain selection, review uncommitted
  changes, open ditfa in a terminal.
- Status-bar item showing connection, active model, and subscription usage.
- Binary resolution across setting, bundled binary, `PATH`, and workspace Cargo
  builds, with actionable guidance when none is found.

## [0.1.1] — Unreleased

### Fixed

- **Wrong wire field names.** The extension still used the pre-rebrand login and
  home-directory field names, which the server had already renamed. Sign-in
  via browser and the startup log line were both affected.
- **Release pipeline never ran.** The workflow's path filters and working
  directories assumed `ditfa-code/` was a subdirectory; it is the repository root.
- **Repository metadata** pointed at `Foshati/arlenta` instead of
  `ditfa-dev/ditfa-cli`.
- **Install instructions** referenced `@ditfa/cli`, which is not a published
  package. The CLI is published as `ditfa`.

### Changed

- Protocol types regenerated after the error-info and response-handoff enums were
  renamed in Rust, so the generated schema filenames now match the types they
  export and `sync-protocol` no longer has to repair them.

### Verified

- End-to-end against a compiled `ditfa` binary: handshake, `thread/start`,
  `model/list`, `account/read`, `permissionProfile/list`, `config/read`, and
  server notifications.
