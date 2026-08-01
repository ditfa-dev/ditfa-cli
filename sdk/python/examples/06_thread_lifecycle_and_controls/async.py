import sys
from pathlib import Path

_EXAMPLES_ROOT = Path(__file__).resolve().parents[1]
if str(_EXAMPLES_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_ROOT))

from _bootstrap import ensure_local_sdk_src, runtime_config

ensure_local_sdk_src()

import asyncio

from ditfa import AsyncDitfa


async def main() -> None:
    async with AsyncDitfa(config=runtime_config()) as ditfa:
        thread = await ditfa.thread_start(
            model="gpt-5.4", config={"model_reasoning_effort": "high"}
        )
        first = await (await thread.turn("One sentence about structured planning.")).run()
        second = await (await thread.turn("Now restate it for a junior engineer.")).run()

        reopened = await ditfa.thread_resume(thread.id)
        listing_active = await ditfa.thread_list(limit=20, archived=False)
        reading = await reopened.read(include_turns=True)

        _ = await reopened.set_name("sdk-lifecycle-demo")
        _ = await ditfa.thread_archive(reopened.id)
        listing_archived = await ditfa.thread_list(limit=20, archived=True)
        unarchived = await ditfa.thread_unarchive(reopened.id)

        resumed = await ditfa.thread_resume(
            unarchived.id,
            model="gpt-5.4",
            config={"model_reasoning_effort": "high"},
        )
        resumed_result = await (await resumed.turn("Continue in one short sentence.")).run()

        forked = await ditfa.thread_fork(unarchived.id, model="gpt-5.4")
        forked_result = await (
            await forked.turn("Take a different angle in one short sentence.")
        ).run()

        compact_result = await unarchived.compact()

        print("Lifecycle OK:", thread.id)
        print("first:", first.id, first.status)
        print("second:", second.id, second.status)
        print("read.turns:", len(reading.thread.turns))
        print("list.active:", len(listing_active.data))
        print("list.archived:", len(listing_archived.data))
        print("resumed:", resumed_result.id, resumed_result.status)
        print("forked:", forked_result.id, forked_result.status)
        print("compact:", compact_result.model_dump(mode="json", by_alias=True))


if __name__ == "__main__":
    asyncio.run(main())
