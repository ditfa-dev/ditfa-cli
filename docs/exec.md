# Non-interactive mode

Use `ditfa exec` to run a task without the interactive terminal interface:

```sh
ditfa exec "explain the parser and list relevant tests"
```

Run the command from the project you want the agent to inspect. The same model-provider configuration applies; see [PROVIDERS.md](../PROVIDERS.md). Consult `ditfa exec --help` for the JSON output and output-schema options supported by your installed version.

Execution may read files, run commands and change your workspace depending on your settings. Choose appropriate [sandbox and approval controls](sandbox.md), keep secrets out of task text and logs, and review changes before using them in production.
