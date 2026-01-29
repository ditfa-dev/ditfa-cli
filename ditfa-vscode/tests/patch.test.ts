import { describe, expect, it } from "vitest";

import { applyUnifiedDiff, PatchApplyError, revertUnifiedDiff } from "../src/diff/patch";

const ORIGINAL = ["one", "two", "three", "four", "five"].join("\n") + "\n";

describe("applyUnifiedDiff", () => {
  it("applies a single-hunk replacement", () => {
    const diff = ["@@ -2,3 +2,3 @@", " two", "-three", "+THREE", " four"].join("\n");
    expect(applyUnifiedDiff(ORIGINAL, diff)).toBe("one\ntwo\nTHREE\nfour\nfive\n");
  });

  it("applies an insertion without removing context", () => {
    const diff = ["@@ -1,2 +1,3 @@", " one", "+one-and-a-half", " two"].join("\n");
    expect(applyUnifiedDiff(ORIGINAL, diff)).toBe("one\none-and-a-half\ntwo\nthree\nfour\nfive\n");
  });

  it("applies multiple hunks in order", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "@@ -4,2 +4,2 @@",
      " four",
      "-five",
      "+FIVE",
    ].join("\n");
    expect(applyUnifiedDiff(ORIGINAL, diff)).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("preserves a missing trailing newline", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-one", "+ONE"].join("\n");
    expect(applyUnifiedDiff("one\ntwo", diff)).toBe("ONE\ntwo");
  });

  it("ignores the diff preamble", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+ONE",
    ].join("\n");
    expect(applyUnifiedDiff(ORIGINAL, diff)).toBe("ONE\ntwo\nthree\nfour\nfive\n");
  });

  it("rejects a patch whose context does not match", () => {
    const diff = ["@@ -1,2 +1,2 @@", " WRONG", "-two", "+TWO"].join("\n");
    expect(() => applyUnifiedDiff(ORIGINAL, diff)).toThrow(PatchApplyError);
  });

  it("rejects a patch that starts past the end of the file", () => {
    const diff = ["@@ -99,1 +99,1 @@", "-x", "+y"].join("\n");
    expect(() => applyUnifiedDiff(ORIGINAL, diff)).toThrow(PatchApplyError);
  });

  it("rejects a patch with no hunks", () => {
    expect(() => applyUnifiedDiff(ORIGINAL, "--- a/f\n+++ b/f\n")).toThrow(PatchApplyError);
  });
});

describe("revertUnifiedDiff", () => {
  it("round-trips an applied patch", () => {
    const diff = ["@@ -2,3 +2,3 @@", " two", "-three", "+THREE", " four"].join("\n");
    const applied = applyUnifiedDiff(ORIGINAL, diff);
    expect(revertUnifiedDiff(applied, diff)).toBe(ORIGINAL);
  });

  it("round-trips an insertion", () => {
    const diff = ["@@ -1,2 +1,3 @@", " one", "+extra", " two"].join("\n");
    const applied = applyUnifiedDiff(ORIGINAL, diff);
    expect(revertUnifiedDiff(applied, diff)).toBe(ORIGINAL);
  });
});
