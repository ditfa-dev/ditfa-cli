import sys
from pathlib import Path

_EXAMPLES_ROOT = Path(__file__).resolve().parents[1]
if str(_EXAMPLES_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_ROOT))

from _bootstrap import (
    ensure_local_sdk_src,
    runtime_config,
    server_label,
)

ensure_local_sdk_src()

from ditfa import Ditfa

with Ditfa(config=runtime_config()) as ditfa:
    print("Server:", server_label(ditfa.metadata))

    thread = ditfa.thread_start(model="gpt-5.4", config={"model_reasoning_effort": "high"})
    result = thread.run("Say hello in one sentence.")
    print("Items:", len(result.items))
    print("Text:", result.final_response)
