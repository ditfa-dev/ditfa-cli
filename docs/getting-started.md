# Getting started with Ditfa CLI

Install the CLI using the [README installation guide](../README.md#install), then confirm `ditfa --version` works in a new terminal.

## Connect your account

Create a Ditfa API key at [chat.ditfa.com/api-keys](https://chat.ditfa.com/api-keys). In macOS or Linux, run:

```sh
export DITFA_API_KEY="your-ditfa-api-key"
cd my-project
ditfa
```

In PowerShell, set `$env:DITFA_API_KEY = "your-ditfa-api-key"` before running `ditfa`. Never commit your API key. To use another provider or a local model, follow [PROVIDERS.md](../PROVIDERS.md).

## Try a small task

Ask the agent to explain the project before requesting edits. Keep your work in version control, review patches and command approvals, and run your project's checks before accepting a change.

| Command | Purpose |
| --- | --- |
| `ditfa` | Start an interactive session in the current directory |
| `ditfa exec "explain the parser"` | Run a task without the interactive UI |
| `ditfa resume` | Select an earlier session to continue |
| `ditfa --help` | Inspect the flags supported by your installed version |

Read [sandbox and approvals](sandbox.md) before granting broader execution permissions. For setup problems, check the key and selected provider, confirm that your account can access the requested model, and consult [Discussions](https://github.com/ditfa-dev/ditfa-cli/discussions). Report reproducible bugs with your CLI version and operating system, with sensitive data removed.
