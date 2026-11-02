import { describe, expect, it } from "vitest";

import { buildUserInput, parseUserText } from "../src/session/promptContext";

describe("buildUserInput", () => {
  it("puts attached files in the text, because the core drops mention inputs", () => {
    const input = buildUserInput(
      "fix it",
      [{ kind: "file", path: "src/a.ts", label: "a.ts" }],
      null,
      null,
    );
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "text" });
    expect((input[0] as { text: string }).text).toContain("- file: src/a.ts");
    expect(input.some((item) => item.type === "mention")).toBe(false);
  });

  it("keeps a plain message plain", () => {
    expect(buildUserInput("hello", [], null, null)).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("does not let a snippet containing a fence close the block early", () => {
    const [first] = buildUserInput(
      "x",
      [{ kind: "selection", path: "a.md", label: "a.md", text: "```\ncode\n```", range: { start: 1, end: 3 } }],
      null,
      null,
    );
    expect((first as { text: string }).text).toContain("````");
  });

  it("sends images and skills as their own inputs", () => {
    const input = buildUserInput(
      "look",
      [{ kind: "image", path: "s.png", label: "s.png", dataUrl: "data:image/png;base64,AA" }],
      null,
      { name: "deploy", path: "/s/SKILL.md" },
    );
    expect(input.map((item) => item.type)).toEqual(["text", "image", "skill"]);
  });

  it("skips the open file when it is already attached", () => {
    const [first] = buildUserInput(
      "x",
      [{ kind: "file", path: "a.ts", label: "a.ts" }],
      { path: "a.ts", line: 3 },
      null,
    );
    expect((first as { text: string }).text).not.toContain("open in editor");
  });
});

describe("notes for the agent", () => {
  it("travel in the context block and never reach the transcript", () => {
    const [first] = buildUserInput("carry on", [], null, null, [
      "the user undid part of your edit to src/a.ts (lines 4-9).\nDo not apply it again.",
    ]);
    const text = (first as { text: string }).text;
    expect(text).toContain("- note: the user undid part of your edit to src/a.ts (lines 4-9). Do not apply it again.");
    expect(parseUserText(text)).toEqual({ text: "carry on", attachments: [] });
  });
});

describe("parseUserText", () => {
  it("round-trips what the transcript shows", () => {
    const [first] = buildUserInput(
      "why does this fail?",
      [
        { kind: "file", path: "src/a.ts", label: "a.ts" },
        { kind: "selection", path: "b.ts", label: "b.ts:1-2", range: { start: 1, end: 2 }, text: "x" },
      ],
      { path: "c.ts", line: 9 },
      null,
    );
    expect(parseUserText((first as { text: string }).text)).toEqual({
      text: "why does this fail?",
      attachments: ["src/a.ts", "b.ts:1-2"],
    });
  });

  it("leaves text without a block alone", () => {
    expect(parseUserText("plain")).toEqual({ text: "plain", attachments: [] });
  });
});
