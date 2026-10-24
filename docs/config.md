# Configuration

For basic configuration instructions, see [the upstream Ditfa documentation](https://github.com/ditfa-dev/ditfa-cli/blob/main/docs/config.md).

For advanced configuration instructions, see [the upstream Ditfa documentation](https://github.com/ditfa-dev/ditfa-cli/blob/main/docs/config.md).

For a full configuration reference, see [the upstream Ditfa documentation](https://github.com/ditfa-dev/ditfa-cli/blob/main/docs/config.md).

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in
`requirements.toml` to ignore user, project, and session hook configs while
still allowing managed hooks from requirements and managed config layers. This
setting is only supported in `requirements.toml`; putting it in `config.toml`
does not enable managed-hooks-only mode.

Ditfa Code is a fork of Ditfa and inherits this behaviour; the upstream documentation applies except where this repository's own docs say otherwise.
