import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Turn } from "../protocol";
import type { Logger } from "../util/logger";
import { mapThreadItem } from "./itemMapper";
import type { ChatEntry, PlanStep, TokenUsageView } from "./types";

/**
 * Keeps each thread's rendered transcript on disk.
 *
 * `thread/resume` replays a lossy history: commands, their output, and file
 * changes are not persisted. Without this a reloaded window would lose the
 * diffs the user reviewed and every checkpoint with them.
 */

const VERSION = 1;
/** Command output is the only thing that grows without bound. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILE_BYTES = 4_000_000;
const MAX_THREADS = 200;

export interface StoredTranscript {
  version: number;
  threadId: string;
  entries: ChatEntry[];
  plan: PlanStep[];
  planExplanation: string | null;
  tokenUsage: TokenUsageView | null;
}

export class TranscriptStore {
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async load(threadId: string): Promise<StoredTranscript | null> {
    try {
      const raw = await readFile(this.fileFor(threadId), "utf8");
      const parsed = JSON.parse(raw) as StoredTranscript;
      return parsed.version === VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(transcript: Omit<StoredTranscript, "version">): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const payload = serialize({ ...transcript, version: VERSION });
      await writeFile(this.fileFor(transcript.threadId), payload, "utf8");
      await this.prune();
    } catch (error) {
      this.logger.warn(`could not save transcript: ${error instanceof Error ? error.message : error}`);
    }
  }

  async remove(threadId: string): Promise<void> {
    await rm(this.fileFor(threadId), { force: true }).catch(() => undefined);
  }

  private fileFor(threadId: string): string {
    return join(this.directory, `${threadId.replace(/[^\w-]/g, "_")}.json`);
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    if (names.length <= MAX_THREADS) {
      return;
    }
    const aged = await Promise.all(
      names.map(async (name) => ({
        path: join(this.directory, name),
        modified: (await stat(join(this.directory, name))).mtimeMs,
      })),
    );
    aged.sort((a, b) => a.modified - b.modified);
    await Promise.all(
      aged.slice(0, aged.length - MAX_THREADS).map((file) => rm(file.path, { force: true })),
    );
  }
}

function serialize(transcript: StoredTranscript): string {
  const trimmed = transcript.entries.map((entry) =>
    entry.kind === "command" && entry.output.length > MAX_OUTPUT_CHARS
      ? { ...entry, output: entry.output.slice(-MAX_OUTPUT_CHARS) }
      : entry,
  );
  let payload = JSON.stringify({ ...transcript, entries: trimmed });
  // Last resort for a pathological thread: keep the newest half until it fits.
  let keep = trimmed;
  while (payload.length > MAX_FILE_BYTES && keep.length > 10) {
    keep = keep.slice(Math.floor(keep.length / 2));
    payload = JSON.stringify({ ...transcript, entries: keep });
  }
  return payload;
}

/**
 * Rebuilds a transcript from the server's turns, preferring our richer copy of
 * each turn. Turns the store has never seen, because they ran in the CLI, fall
 * back to the server's items.
 */
export function mergeTranscript(turns: Turn[], stored: ChatEntry[] | null): ChatEntry[] {
  const storedByTurn = new Map<string, ChatEntry[]>();
  for (const entry of stored ?? []) {
    if (!entry.turnId) {
      continue;
    }
    const bucket = storedByTurn.get(entry.turnId);
    if (bucket) {
      bucket.push(entry);
    } else {
      storedByTurn.set(entry.turnId, [entry]);
    }
  }

  const merged: ChatEntry[] = [];
  for (const turn of turns) {
    const known = storedByTurn.get(turn.id);
    if (known) {
      merged.push(...known);
      continue;
    }
    const at = (turn.startedAt ?? 0) * 1000;
    for (const item of turn.items) {
      const entry = mapThreadItem(item, at, turn.id);
      if (entry) {
        merged.push(entry);
      }
    }
  }
  return merged;
}
