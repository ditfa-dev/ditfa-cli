# OpenAI Ditfa Python SDK

Build Python applications that start Ditfa threads, run turns, stream progress,
and control workspace access.

## Install

Install the SDK:

```bash
pip install openai-ditfa
```

## Quickstart

The SDK reuses your existing Ditfa authentication when one is already
available:

```python
from ditfa import Ditfa

with Ditfa() as ditfa:
    thread = ditfa.thread_start()
    result = thread.run("Explain this repository in three bullets.")
    print(result.final_response)
```

`thread.run(...)` returns a `TurnResult` containing the final response,
collected items, and token usage.

## Authentication

Existing Ditfa authentication is reused automatically. To start ChatGPT
browser login explicitly:

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
    login.wait()
```

For API-key login:

```python
with Ditfa() as ditfa:
    ditfa.login_api_key("sk-...")
```

## Built-In Help

Use Python's standard `help(ditfa)`, `help(Ditfa)`, or
`python -m pydoc ditfa` documentation tools.

## Documentation

- [Getting started](https://github.com/ditfa-dev/ditfa-cli/blob/main/sdk/python/docs/getting-started.md)
- [API reference](https://github.com/ditfa-dev/ditfa-cli/blob/main/sdk/python/docs/api-reference.md)
- [FAQ](https://github.com/ditfa-dev/ditfa-cli/blob/main/sdk/python/docs/faq.md)
- [Examples](https://github.com/ditfa-dev/ditfa-cli/blob/main/sdk/python/examples/README.md)

The package is licensed under the
[repository Apache License 2.0](https://github.com/ditfa-dev/ditfa-cli/blob/main/LICENSE).
