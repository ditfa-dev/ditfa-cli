import { isAbsolute, join } from "node:path";

import { PatchApplyError, revertUnifiedDiff } from "../diff/patch";
import type { FileChangeSummary } from "../session/types";

/**
 * Works out how to undo a run of applied file changes.
 *
 * Checkpoints here need neither Git nor a shadow repository: every change the
 * agent made through the patch tool is already recorded as a diff, so undoing is
 * reversing those diffs newest-first against what is on disk. Nothing is written
 * here, which keeps the logic testable and lets the caller show the plan first.
 *
 * Commands the agent ran are out of reach — a `rm` or an `npm install` leaves no
 * diff — and the UI says so.
 */

export interface RevertStep {
  path: string;
  /** New contents, or null to delete the file. */
  content: string | null;
}

export interface RevertPlan {
  steps: RevertStep[];
  /** Files left alone, each with the reason. */
  skipped: { path: string; reason: string }[];
}

export type ReadFile = (path: string) => Promise<string | null>;

/** `changes` must be ordered oldest to newest, as they were applied. */
export async function planRevert(
  changes: FileChangeSummary[],
  cwd: string,
  read: ReadFile,
): Promise<RevertPlan> {
  // In-memory view of the tree, so several edits to one file stack correctly.
  const contents = new Map<string, string | null>();
  const conflicted = new Map<string, string>();

  const current = async (path: string): Promise<string | null> => {
    if (!contents.has(path)) {
      contents.set(path, await read(path));
    }
    return contents.get(path) ?? null;
  };

  for (const change of [...changes].reverse()) {
    const path = absolute(change.path, cwd);
    if (conflicted.has(path)) {
      continue;
    }

    switch (change.kind) {
      case "add":
        await current(path);
        contents.set(path, null);
        break;

      case "delete":
        contents.set(path, change.diff);
        break;

      case "update": {
        const destination = change.movePath ? absolute(change.movePath, cwd) : path;
        const after = await current(destination);
        if (after === null) {
          conflicted.set(path, "the file no longer exists");
          break;
        }
        try {
          const before = revertUnifiedDiff(after, change.diff);
          contents.set(path, before);
          if (destination !== path) {
            contents.set(destination, null);
          }
        } catch (error) {
          if (!(error instanceof PatchApplyError)) {
            throw error;
          }
          conflicted.set(path, "it was edited after the agent changed it");
        }
        break;
      }
    }
  }

  const steps: RevertStep[] = [];
  for (const [path, content] of contents) {
    if (conflicted.has(path)) {
      continue;
    }
    if (content !== (await read(path))) {
      steps.push({ path, content });
    }
  }

  return {
    steps,
    skipped: [...conflicted].map(([path, reason]) => ({ path, reason })),
  };
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}
