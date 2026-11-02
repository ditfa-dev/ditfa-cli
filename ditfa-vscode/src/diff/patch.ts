/**
 * Minimal unified-diff application.
 *
 * app-server hands out patches as unified diffs but VS Code's diff editor wants
 * two full documents. Rather than guess, this applies the hunks strictly: every
 * context and removal line must match the source exactly, and any mismatch
 * throws so callers can fall back to rendering the raw patch instead of showing
 * the user a plausible-looking but wrong document.
 */

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk body: each line keeps its ` `, `+`, `-` or backslash marker. */
  lines: string[];
}

type Hunk = DiffHunk;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Applies `diff` to `original` and returns the patched text. */
export function applyUnifiedDiff(original: string, diff: string): string {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    throw new PatchApplyError("patch contains no hunks");
  }

  const { lines: sourceLines, trailingNewline } = splitLines(original);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    // Hunk headers are 1-based; a pure insertion into an empty file uses 0.
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new PatchApplyError(`hunk at line ${hunk.oldStart} overlaps a previous hunk`);
    }
    if (start > sourceLines.length) {
      throw new PatchApplyError(`hunk starts past end of file (line ${hunk.oldStart})`);
    }
    result.push(...sourceLines.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      const marker = line[0] ?? " ";
      const content = line.slice(1);
      switch (marker) {
        case " ":
          expectLine(sourceLines, cursor, content, "context");
          result.push(content);
          cursor += 1;
          break;
        case "-":
          expectLine(sourceLines, cursor, content, "removed");
          cursor += 1;
          break;
        case "+":
          result.push(content);
          break;
        case "\\":
          // "\ No newline at end of file" — metadata, not content.
          break;
        default:
          throw new PatchApplyError(`unrecognized diff line: ${line}`);
      }
    }
  }

  result.push(...sourceLines.slice(cursor));
  return result.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Applies `diff` backwards, reconstructing the pre-patch text from post-patch
 * text. Used when the agent has already written the file to disk.
 */
export function revertUnifiedDiff(modified: string, diff: string): string {
  return applyUnifiedDiff(modified, reverseDiff(diff));
}

function reverseDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      const header = HUNK_HEADER.exec(line);
      if (header) {
        const [, oldStart, oldLines, newStart, newLines] = header;
        return `@@ -${newStart},${newLines ?? "1"} +${oldStart},${oldLines ?? "1"} @@`;
      }
      if (line.startsWith("+++") || line.startsWith("---")) {
        return line;
      }
      if (line.startsWith("+")) {
        return `-${line.slice(1)}`;
      }
      if (line.startsWith("-")) {
        return `+${line.slice(1)}`;
      }
      return line;
    })
    .join("\n");
}

/** The hunks of a unified diff, in file order. */
export function listHunks(diff: string): DiffHunk[] {
  return parseHunks(diff);
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      // Preamble (`--- a/x`, `+++ b/x`, `diff --git …`) before the first hunk.
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
      continue;
    }
    current.lines.push(line);
  }

  // A trailing newline in the patch text yields one empty element; it is not a
  // context line and would fail the strict match below.
  for (const hunk of hunks) {
    while (hunk.lines.length > 0 && hunk.lines[hunk.lines.length - 1] === "") {
      hunk.lines.pop();
    }
  }

  return hunks;
}

function expectLine(source: string[], index: number, expected: string, role: string): void {
  if (index >= source.length) {
    throw new PatchApplyError(`${role} line past end of file: ${JSON.stringify(expected)}`);
  }
  if (source[index] !== expected) {
    throw new PatchApplyError(
      `${role} line ${index + 1} does not match: expected ${JSON.stringify(expected)}, found ${JSON.stringify(source[index])}`,
    );
  }
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.length === 0 && trailingNewline ? [] : body.split("\n"), trailingNewline };
}

/** Lines a hunk adds and removes, for the review card. */
export function hunkStats(hunk: DiffHunk): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * Undoes one hunk in the file as it is now.
 *
 * Hunks are located by their content, not by their line numbers: an earlier
 * hunk that was already undone, or an edit above it, moves everything below. The
 * match nearest the recorded position wins, and no match at all means the user
 * changed that region since, so the caller leaves the file alone.
 */
export function revertHunk(current: string, hunk: DiffHunk): string {
  const after: string[] = [];
  const before: string[] = [];
  for (const line of hunk.lines) {
    const content = line.slice(1);
    if (line.startsWith(" ")) {
      after.push(content);
      before.push(content);
    } else if (line.startsWith("+")) {
      after.push(content);
    } else if (line.startsWith("-")) {
      before.push(content);
    }
  }
  if (after.length === 0) {
    // Nothing to anchor on: guessing where to put the lines back would be worse than refusing.
    throw new PatchApplyError("the change has no surrounding lines to locate it by");
  }

  const { lines, trailingNewline } = splitLines(current);
  const expected = Math.max(0, hunk.newStart - 1);
  let found = -1;
  for (let start = 0; start + after.length <= lines.length; start += 1) {
    if (after.every((line, offset) => lines[start + offset] === line)) {
      if (found === -1 || Math.abs(start - expected) < Math.abs(found - expected)) {
        found = start;
      }
    }
  }
  if (found === -1) {
    throw new PatchApplyError("this part of the file was edited after the agent changed it");
  }

  lines.splice(found, after.length, ...before);
  return lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
}

/**
 * The diff from the original file to what is on disk once `reverted` hunks have
 * been undone. Whole-turn restore and the diff editor reverse a patch strictly
 * by position, so the hunks that remain need their new-side line numbers shifted
 * by what the undone ones used to add or remove. Empty when nothing is left.
 */
export function effectiveDiff(diff: string, reverted: readonly number[]): string {
  if (reverted.length === 0) {
    return diff;
  }
  const hunks = parseHunks(diff);
  const gone = new Set(reverted);
  const out: string[] = [];
  const firstHunk = diff.split("\n").findIndex((line) => HUNK_HEADER.test(line));
  if (firstHunk > 0) {
    out.push(...diff.split("\n").slice(0, firstHunk));
  }

  let shift = 0;
  let kept = 0;
  hunks.forEach((hunk, index) => {
    if (gone.has(index)) {
      shift += hunk.newLines - hunk.oldLines;
      return;
    }
    kept += 1;
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart - shift},${hunk.newLines} @@`);
    out.push(...hunk.lines);
  });
  return kept === 0 ? "" : `${out.join("\n")}\n`;
}
