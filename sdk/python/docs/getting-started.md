# Getting Started

This guide gets a published OpenAI Ditfa Python SDK installation running
with a multi-turn thread.

## 1. Install

Install the SDK:

```bash
pip install openai-ditfa
```

Requirements:

- Python `>=3.10`
- An existing Ditfa account session, or one of the login flows below

The SDK installs its matching `openai-ditfa-cli-bin` runtime dependency
automatically. SDK release versions track the corresponding Ditfa CLI release.

## 2. Authenticate When Needed

Existing Ditfa authentication is reused automatically. For ChatGPT browser
login:

```python
from ditfa import Ditfa

with Ditfa() as ditfa:
    login = ditfa.login_chatgpt()
    print(login.auth_url)
    print(login.wait().success)
```

For device-code login:

```python
with Ditfa() as ditfa:
    login = ditfa.login_chatgpt_device_code()
    print(login.verification_url, login.user_code)
    print(login.wait().success)
```

For API-key login:

```python
with Ditfa() as ditfa:
    ditfa.login_api_key("sk-...")
    print(ditfa.account().account)
```

## 3. Run A Turn

```python
from ditfa import Ditfa, Sandbox

with Ditfa() as ditfa:
    thread = ditfa.thread_start(sandbox=Sandbox.workspace_write)
    result = thread.run("Say hello in one sentence.")

    print("Thread:", thread.id)
    print("Text:", result.final_response)
    print("Items:", len(result.items))
```

`Thread.run(...)` starts a turn, waits for completion, and returns
`TurnResult`. Plain strings are shorthand for `TextInput(...)`.

Use `Thread.turn(...)` when you need a `TurnHandle` for streaming, steering,
or interrupting an active turn.

## 4. Choose Sandbox Access

Use one enum for the initial thread and later turn overrides:

```python
from ditfa import Ditfa, Sandbox

with Ditfa() as ditfa:
    thread = ditfa.thread_start(sandbox=Sandbox.workspace_write)
    thread.run("Make the requested changes.")
    review = thread.run("Review the diff only.", sandbox=Sandbox.read_only)
```

Available presets:

- `Sandbox.read_only`: read files without allowing writes.
- `Sandbox.workspace_write`: read files and write inside the workspace and
  configured writable roots; this is the normal default for workspace work.
- `Sandbox.full_access`: run without filesystem access restrictions.

When `sandbox=` is omitted, Ditfa uses its configured default. A turn override
also applies to subsequent turns on that thread.

## 5. Continue A Thread

```python
from ditfa import Ditfa

with Ditfa() as ditfa:
    thread = ditfa.thread_start()
    thread.run("Summarize Rust ownership in two bullets.")
    result = thread.run("Now explain it to a Python developer.")
    print(result.final_response)
```

To resume a stored thread later:

```python
with Ditfa() as ditfa:
    thread = ditfa.thread_resume("thr_123")
    print(thread.run("Continue where we left off.").final_response)
```

## 6. Use The Async Client

```python
import asyncio

from ditfa import AsyncDitfa, Sandbox


async def main() -> None:
    async with AsyncDitfa() as ditfa:
        thread = await ditfa.thread_start(sandbox=Sandbox.workspace_write)
        result = await thread.run("Continue where we left off.")
        print(result.final_response)


asyncio.run(main())
```

## 7. Get Help

Python's built-in documentation tools cover the curated SDK surface:

```python
import ditfa
from ditfa import Ditfa, DitfaConfig

help(ditfa)
help(Ditfa)
help(DitfaConfig)
```

```bash
python -m pydoc ditfa
```

## Developing From This Repository

Contributors working from a checkout can install development dependencies from
the repository:

```bash
cd sdk/python
uv sync --group dev
source .venv/bin/activate
```

## Next Stops

- [API reference](https://github.com/Teamtem-dev/ditfa-code/blob/main/sdk/python/docs/api-reference.md)
- [FAQ](https://github.com/Teamtem-dev/ditfa-code/blob/main/sdk/python/docs/faq.md)
- [Runnable examples](https://github.com/Teamtem-dev/ditfa-code/blob/main/sdk/python/examples/README.md)
