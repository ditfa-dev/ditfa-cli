import { describe, expect, it } from "vitest";

import { countDiffLines, displayCommand, mapThreadItem, summarizeChange } from "../src/session/itemMapper";
import type { ThreadItem } from "../src/protocol";

const AT = 1_700_000_000_000;

describe("mapThreadItem", () => {
  it("flattens a user message and lifts its context block into attachments", () => {
    const item = {
      type: "userMessage",
      id: "u1",
      clientId: null,
      content: [
        {
          type: "text",
          text: "look at this\n\n<ditfa-context>\n- file: src/main.rs\n</ditfa-context>",
          text_elements: [],
        },
      ],
    } as ThreadItem;

    const entry = mapThreadItem(item, AT);
    expect(entry).toEqual({
      id: "u1",
      kind: "user",
      at: AT,
      text: "look at this",
      attachments: ["src/main.rs"],
      clientId: null,
      turnId: null,
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

  it("keeps a written plan as its own transcript row", () => {
    const item = { type: "plan", id: "p1", text: "do the thing" } as ThreadItem;
    expect(mapThreadItem(item, AT)).toMatchObject({ kind: "plan", text: "do the thing" });
  });

  it("shows the command, not the login shell wrapping it", () => {
    expect(displayCommand("/bin/zsh -lc 'echo hello'")).toBe("echo hello");
    expect(displayCommand("bash -c \"npm test\"")).toBe("npm test");
    expect(displayCommand("/bin/zsh -lc 'echo it'\\''s'")).toBe("echo it's");
    expect(displayCommand("ls -la")).toBe("ls -la");
  });

  it("counts a new file's content as additions, since adds carry no diff", () => {
    const summary = summarizeChange({
      path: "/w/new.txt",
      kind: { type: "add" },
      diff: "one\ntwo\n+three\n",
    });
    expect(summary).toMatchObject({ additions: 3, deletions: 0 });
  });

  it("strips the server's move note so the hunks still parse", () => {
    const summary = summarizeChange({
      path: "/w/a.txt",
      kind: { type: "update", move_path: "/w/b.txt" },
      diff: "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /w/b.txt",
    });
    expect(summary.diff).toBe("@@ -1 +1 @@\n-a\n+b\n");
    expect(summary.movePath).toBe("/w/b.txt");
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
