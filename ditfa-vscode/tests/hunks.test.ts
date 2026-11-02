import { describe, expect, it } from "vitest";

import {
  applyUnifiedDiff,
  effectiveDiff,
  hunkStats,
  listHunks,
  PatchApplyError,
  revertHunk,
  revertUnifiedDiff,
} from "../src/diff/patch";

const ORIGINAL = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

// Three hunks: a same-size edit, a two-line insertion, a one-line deletion.
const DIFF = [
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -2,7 +2,7 @@",
  " line 2",
  " line 3",
  " line 4",
  "-line 5",
  "+line five",
  " line 6",
  " line 7",
  " line 8",
  "@@ -18,6 +18,8 @@",
  " line 18",
  " line 19",
  " line 20",
  "+new a",
  "+new b",
  " line 21",
  " line 22",
  " line 23",
  "@@ -25,6 +27,5 @@",
  " line 25",
  " line 26",
  " line 27",
  "-line 28",
  " line 29",
  " line 30",
].join("\n");

const MODIFIED = applyUnifiedDiff(ORIGINAL, DIFF);

describe("listHunks", () => {
  it("reads both sides of every header", () => {
    const hunks = listHunks(DIFF);
    expect(hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([
      [2, 7, 2, 7],
      [18, 6, 18, 8],
      [25, 6, 27, 5],
    ]);
  });

  it("counts what each hunk adds and removes", () => {
    expect(listHunks(DIFF).map(hunkStats)).toEqual([
      { additions: 1, deletions: 1 },
      { additions: 2, deletions: 0 },
      { additions: 0, deletions: 1 },
    ]);
  });
});

describe("revertHunk", () => {
  it("undoes only the chosen hunk", () => {
    const hunks = listHunks(DIFF);
    const result = revertHunk(MODIFIED, hunks[1]!);
    expect(result).toContain("line five");
    expect(result).not.toContain("new a");
    expect(result).not.toContain("line 28");
  });

  it("agrees with the positional diff of the hunks that stay", () => {
    const hunks = listHunks(DIFF);
    expect(revertHunk(MODIFIED, hunks[1]!)).toBe(applyUnifiedDiff(ORIGINAL, effectiveDiff(DIFF, [1])));
  });

  it("finds a hunk that moved because an earlier one was undone", () => {
    const hunks = listHunks(DIFF);
    const afterFirst = revertHunk(MODIFIED, hunks[1]!);
    // The third hunk now sits two lines higher than its recorded position.
    expect(revertHunk(afterFirst, hunks[2]!)).toBe(applyUnifiedDiff(ORIGINAL, effectiveDiff(DIFF, [1, 2])));
  });

  it("restores the original once every hunk is undone, in any order", () => {
    const hunks = listHunks(DIFF);
    let text = MODIFIED;
    for (const index of [2, 0, 1]) {
      text = revertHunk(text, hunks[index]!);
    }
    expect(text).toBe(ORIGINAL);
  });

  it("refuses when the user edited that part of the file", () => {
    const edited = MODIFIED.replace("new a", "something else");
    expect(() => revertHunk(edited, listHunks(DIFF)[1]!)).toThrow(PatchApplyError);
  });

  it("refuses a hunk it has no lines to anchor on", () => {
    const hunk = listHunks("@@ -5,1 +5,0 @@\n-gone")[0]!;
    expect(() => revertHunk(MODIFIED, hunk)).toThrow(PatchApplyError);
  });

  it("keeps a missing trailing newline", () => {
    const diff = ["@@ -1,2 +1,2 @@", " a", "-b", "+B"].join("\n");
    expect(revertHunk("a\nB", listHunks(diff)[0]!)).toBe("a\nb");
  });
});

describe("effectiveDiff", () => {
  it("is the diff itself when nothing was undone", () => {
    expect(effectiveDiff(DIFF, [])).toBe(DIFF);
  });

  it("reverses cleanly against the file as it is after an undo", () => {
    const hunks = listHunks(DIFF);
    const current = revertHunk(MODIFIED, hunks[0]!);
    expect(revertUnifiedDiff(current, effectiveDiff(DIFF, [0]))).toBe(ORIGINAL);
  });

  it("shifts the hunks below an undone insertion", () => {
    const diff = effectiveDiff(DIFF, [1]);
    expect(listHunks(diff).map((hunk) => hunk.newStart)).toEqual([2, 25]);
  });

  it("keeps the file header", () => {
    expect(effectiveDiff(DIFF, [0]).startsWith("--- a/f.txt\n+++ b/f.txt\n")).toBe(true);
  });

  it("is empty when every hunk was undone", () => {
    expect(effectiveDiff(DIFF, [0, 1, 2])).toBe("");
  });
});
