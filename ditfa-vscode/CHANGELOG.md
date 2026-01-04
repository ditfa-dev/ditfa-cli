# Changelog

All notable changes to the Ditfa Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

### Known limitations

- Not yet exercised against a compiled `ditfa` binary; verification so far is
  type-level plus protocol-level integration tests against a stand-in server.
- `ditfa-rs/app-server-protocol` ships two generated files whose names disagree
  with the types they export (`ditfaErrorInfo.ts` exports `CodexErrorInfo`).
  `scripts/sync-protocol.mjs` renames them on import; the fix belongs upstream.
