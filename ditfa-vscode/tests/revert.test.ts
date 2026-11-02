import { describe, expect, it } from "vitest";

import { planRevert } from "../src/checkpoints/revert";
import type { FileChangeSummary } from "../src/session/types";

const change = (partial: Partial<FileChangeSummary> & { path: string }): FileChangeSummary => ({
  label: partial.path,
  kind: "update",
  movePath: null,
  additions: 0,
  deletions: 0,
  diff: "",
  ...partial,
});

const disk = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe("planRevert", () => {
  it("deletes a file the agent created", async () => {
    const plan = await planRevert(
      [change({ path: "/w/new.ts", kind: "add", diff: "x\n" })],
      "/w",
      disk({ "/w/new.ts": "x\n" }),
    );
    expect(plan.steps).toEqual([{ path: "/w/new.ts", content: null }]);
  });

  it("recreates a file the agent deleted from its recorded content", async () => {
    const plan = await planRevert(
      [change({ path: "/w/old.ts", kind: "delete", diff: "keep me\n" })],
      "/w",
      disk({}),
    );
    expect(plan.steps).toEqual([{ path: "/w/old.ts", content: "keep me\n" }]);
  });

  it("unwinds several edits to one file newest first", async () => {
    const plan = await planRevert(
      [
        change({ path: "/w/a.ts", diff: "@@ -1 +1 @@\n-one\n+two\n" }),
        change({ path: "/w/a.ts", diff: "@@ -1 +1 @@\n-two\n+three\n" }),
      ],
      "/w",
      disk({ "/w/a.ts": "three\n" }),
    );
    expect(plan.steps).toEqual([{ path: "/w/a.ts", content: "one\n" }]);
  });

  it("leaves a file the user edited afterwards alone", async () => {
    const plan = await planRevert(
      [change({ path: "/w/a.ts", diff: "@@ -1 +1 @@\n-one\n+two\n" })],
      "/w",
      disk({ "/w/a.ts": "mine now\n" }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.skipped[0]?.path).toBe("/w/a.ts");
  });

  it("moves a renamed file back", async () => {
    const plan = await planRevert(
      [change({ path: "/w/a.ts", movePath: "/w/b.ts", diff: "@@ -1 +1 @@\n-one\n+two\n" })],
      "/w",
      disk({ "/w/b.ts": "two\n" }),
    );
    expect(plan.steps).toContainEqual({ path: "/w/a.ts", content: "one\n" });
    expect(plan.steps).toContainEqual({ path: "/w/b.ts", content: null });
  });

  it("resolves relative paths against the thread's folder", async () => {
    const plan = await planRevert(
      [change({ path: "new.ts", kind: "add", diff: "x" })],
      "/w",
      disk({ "/w/new.ts": "x" }),
    );
    expect(plan.steps[0]?.path).toBe("/w/new.ts");
  });

  it("leaves out hunks the user already took back", async () => {
    // The file as it is now: the first hunk was undone by hand, the second stays.
    const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n") + "\n";
    const diff = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -10,3 +10,4 @@",
      " j",
      " k",
      "+K2",
      " l",
    ].join("\n");
    const now = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "K2", "l"].join("\n") + "\n";
    const plan = await planRevert(
      [change({ path: "/w/a.txt", diff, reverted: [0] })],
      "/w",
      disk({ "/w/a.txt": now }),
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.steps).toEqual([{ path: "/w/a.txt", content: original }]);
  });

  it("has nothing to do for a file the user already deleted or restored", async () => {
    const plan = await planRevert(
      [change({ path: "/w/new.ts", kind: "add", diff: "x\n", undone: true })],
      "/w",
      disk({}),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});
