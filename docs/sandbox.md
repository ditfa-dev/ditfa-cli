# Sandbox and approvals

Ditfa CLI can read files, edit code and run commands on your computer. Sandbox settings control the environment available to those commands; approval settings control when a proposed command needs your decision. Review both before starting work.

## Choose a sandbox

| `--sandbox` value | Intended access |
| --- | --- |
| `read-only` | Inspect the project without granting normal write access |
| `workspace-write` | Allow writes in the configured workspace and permitted writable locations |
| `danger-full-access` | Remove the CLI's sandbox restrictions; commands use the permissions of the running process |

Operating-system enforcement differs between macOS, Linux and Windows. Network access, additional writable directories, project configuration and approvals affect the effective boundary. A sandbox is not a substitute for reviewing commands or protecting credentials.

## Choose an approval policy

`--ask-for-approval untrusted` asks before commands outside the trusted command set. `on-request` lets the agent decide when to request approval. `never` returns execution failures to the agent without prompting; it does not by itself grant unrestricted sandbox access.

For an initial review of an unfamiliar project:

```sh
ditfa --sandbox read-only --ask-for-approval untrusted
```

For work requiring project edits, explicitly select `--sandbox workspace-write` and review the proposed commands. `--add-dir` expands writable access beyond the primary workspace, so add only the directories your task needs.

## Work safely

Keep a clean version-control checkpoint, inspect changes and run relevant tests. Do not place credentials in prompts or project files. Treat repository instructions, model output and tool responses as potentially untrusted input.

The `--dangerously-bypass-approvals-and-sandbox` flag disables both protections. Reserve it for an environment that is already isolated and whose access you understand; it is not needed for a normal interactive workflow.

Use `ditfa --help` to confirm the options supported by your installed version. Report suspected boundary violations through [private vulnerability reporting](../SECURITY.md).
