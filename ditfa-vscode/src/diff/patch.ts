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

interface Hunk {
  oldStart: number;
  oldLines: number;
  lines: string[];
}

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

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
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
