import { describe, expect, it } from "vitest";

import { countDiffLines, mapThreadItem, summarizeChange } from "../src/session/itemMapper";
import type { ThreadItem } from "../src/protocol";

const AT = 1_700_000_000_000;

describe("mapThreadItem", () => {
  it("flattens a user message and lifts its mentions into attachments", () => {
    const item = {
      type: "userMessage",
      id: "u1",
      clientId: null,
      content: [
        { type: "text", text: "look at this", text_elements: [] },
        { type: "mention", name: "main.rs", path: "src/main.rs" },
      ],
    } as ThreadItem;

    const entry = mapThreadItem(item, AT);
    expect(entry).toEqual({
      id: "u1",
      kind: "user",
      at: AT,
      text: "look at this",
      attachments: ["src/main.rs"],
    });
  });

  it("joins reasoning summary and content", () => {
    const item = {
      type: "reasoning",
      id: "r1",
      summary: ["first"],
      content: ["second"],
    } as ThreadItem;

    const entry = mapThreadItem(item, AT);
    expect(entry).toMatchObject({ kind: "reasoning", summary: "first\n\nsecond", streaming: false });
  });

  it("normalizes command execution status", () => {
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "cargo test",
      cwd: "/repo",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    } as unknown as ThreadItem;

    expect(mapThreadItem(item, AT)).toMatchObject({ kind: "command", status: "running", output: "" });
  });

  it("maps a declined patch to aborted rather than failed", () => {
    const item = {
      type: "fileChange",
      id: "f1",
      status: "declined",
      changes: [],
    } as unknown as ThreadItem;

    expect(mapThreadItem(item, AT)).toMatchObject({ kind: "fileChange", status: "aborted" });
  });

  it("drops plan items, which render from turn/plan/updated instead", () => {
    const item = { type: "plan", id: "p1", text: "do the thing" } as ThreadItem;
    expect(mapThreadItem(item, AT)).toBeNull();
  });

  it("keeps unfamiliar tool calls visible rather than dropping them", () => {
    const item = {
      type: "dynamicToolCall",
      id: "d1",
      namespace: "fs",
      tool: "read",
      arguments: {},
      status: "completed",
      contentItems: null,
      success: true,
      durationMs: 12,
    } as unknown as ThreadItem;

    expect(mapThreadItem(item, AT)).toMatchObject({
      kind: "toolCall",
      title: "fs.read",
      status: "completed",
    });
  });
});

describe("countDiffLines", () => {
  it("counts changed lines and ignores file headers", () => {
    const diff = ["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " ctx", "-old", "+new"].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("counts a pure addition", () => {
    const diff = ["@@ -0,0 +1,3 @@", "+a", "+b", "+c"].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 3, deletions: 0 });
  });
});

describe("summarizeChange", () => {
  it("derives a basename label and carries the move target", () => {
    const summary = summarizeChange({
      path: "src/deep/nested/file.ts",
      kind: { type: "update", move_path: "src/moved.ts" },
      diff: "@@ -1,1 +1,1 @@\n-a\n+b",
    });

    expect(summary.label).toBe("file.ts");
    expect(summary.kind).toBe("update");
    expect(summary.movePath).toBe("src/moved.ts");
    expect(summary.additions).toBe(1);
    expect(summary.deletions).toBe(1);
  });

  it("handles Windows-style paths", () => {
    const summary = summarizeChange({
      path: "C:\\repo\\src\\file.ts",
      kind: { type: "add" },
      diff: "@@ -0,0 +1,1 @@\n+x",
    });
    expect(summary.label).toBe("file.ts");
  });
});
