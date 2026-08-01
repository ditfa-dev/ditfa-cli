import sys
from pathlib import Path

_EXAMPLES_ROOT = Path(__file__).resolve().parents[1]
if str(_EXAMPLES_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_ROOT))

from _bootstrap import ensure_local_sdk_src, runtime_config, server_label

ensure_local_sdk_src()

import asyncio

from ditfa import AsyncDitfa


async def main() -> None:
    async with AsyncDitfa(config=runtime_config()) as ditfa:
        print("server:", server_label(ditfa.metadata))
        models = await ditfa.models()
        print("models.count:", len(models.data))
        print("models:", ", ".join(model.id for model in models.data[:5]))


if __name__ == "__main__":
    asyncio.run(main())
