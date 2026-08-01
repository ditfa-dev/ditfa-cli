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

## [0.1.1] — Unreleased

### Fixed

- **Wrong wire field names.** The extension still used the pre-rebrand login and
  home-directory field names, which the server had already renamed. Sign-in
  via browser and the startup log line were both affected.
- **Release pipeline never ran.** The workflow's path filters and working
  directories assumed `ditfa-code/` was a subdirectory; it is the repository root.
- **Repository metadata** pointed at `Foshati/arlenta` instead of
  `Teamtem-dev/ditfa-code`.
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
