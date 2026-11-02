# Configuration

Ditfa CLI reads user configuration from `~/.ditfa/config.toml`, or from the directory selected by `DITFA_HOME`. Command-line `-c key=value` overrides let you choose settings for an individual run.

## Model and provider

```toml
model_provider = "ditfa"
model = "auto"
```

Set `DITFA_API_KEY` in your environment. Other providers use their own key variables and model identifiers; see [PROVIDERS.md](../PROVIDERS.md). Avoid storing secrets directly in configuration files or checking them into version control.

For a single run with a provider and an available model:

```sh
ditfa -c model_provider=anthropic -m YOUR_MODEL_ID
```

## Execution controls

Choose a sandbox and approval policy explicitly when needed:

```sh
ditfa --sandbox read-only --ask-for-approval untrusted
```

Read [sandbox and approvals](sandbox.md) before expanding permissions. Run `ditfa --help` for options supported by your installed version. The checked-in [configuration schema](../ditfa-rs/core/config.schema.json) describes the development revision; installed releases may differ.

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in `requirements.toml` to ignore user, project and session hook configs while still allowing managed hooks from requirements and managed config layers. This setting is only supported in `requirements.toml`; putting it in `config.toml` does not enable managed-hooks-only mode.
