import type { UserInput } from "../protocol";
import type { ContextAttachment } from "./types";

/**
 * Turns what the user attached into model input.
 *
 * The protocol's `mention` input is for plugins: the core drops it before the
 * request is built, so a file sent that way never reaches the model. Files go in
 * as a text block instead, which the agent reads with its own tools, and which
 * the transcript strips back out so the user sees chips rather than the block.
 */

const OPEN = "<ditfa-context>";
const CLOSE = "</ditfa-context>";

export interface ActiveFileContext {
  path: string;
  line: number | null;
}

export function buildUserInput(
  text: string,
  attachments: ContextAttachment[],
  activeFile: ActiveFileContext | null,
  skill: { name: string; path: string } | null,
  notes: string[] = [],
): UserInput[] {
  const block = renderContextBlock(attachments, activeFile, notes);
  const input: UserInput[] = [
    { type: "text", text: block ? `${text}\n\n${block}` : text, text_elements: [] },
  ];

  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      continue;
    }
    if (attachment.dataUrl) {
      input.push({ type: "image", url: attachment.dataUrl });
    } else {
      input.push({ type: "localImage", path: attachment.path });
    }
  }
  if (skill) {
    input.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return input;
}

function renderContextBlock(
  attachments: ContextAttachment[],
  activeFile: ActiveFileContext | null,
  notes: string[],
): string {
  const lines: string[] = [];
  const snippets: string[] = [];

  for (const attachment of attachments) {
    switch (attachment.kind) {
      case "file":
        lines.push(`- file: ${attachment.path}`);
        break;
      case "folder":
        lines.push(`- folder: ${attachment.path}`);
        break;
      case "selection": {
        const range = attachment.range ? `:${attachment.range.start}-${attachment.range.end}` : "";
        lines.push(`- selection: ${attachment.path}${range}`);
        snippets.push(fence(attachment.text ?? "", attachment.language ?? ""));
        break;
      }
      case "image":
        break;
    }
  }

  if (activeFile && !attachments.some((item) => item.path === activeFile.path)) {
    const line = activeFile.line === null ? "" : ` (cursor at line ${activeFile.line})`;
    lines.push(`- open in editor: ${activeFile.path}${line}`);
  }

  // One line each: the block is line-oriented and the transcript strips it whole.
  for (const note of notes) {
    lines.push(`- note: ${note.replace(/\s+/g, " ").trim()}`);
  }

  if (lines.length === 0) {
    return "";
  }
  return [OPEN, ...lines, ...snippets, CLOSE].join("\n");
}

/** Uses a fence longer than any run of backticks in the snippet, so it cannot close early. */
function fence(text: string, language: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}

/** Splits a stored user message back into what they typed and what they attached. */
export function parseUserText(raw: string): { text: string; attachments: string[] } {
  const start = raw.lastIndexOf(OPEN);
  const end = raw.lastIndexOf(CLOSE);
  if (start === -1 || end < start) {
    return { text: raw, attachments: [] };
  }

  const body = raw.slice(start + OPEN.length, end);
  const attachments: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^- (file|folder|selection): (.+)$/.exec(line);
    if (match?.[2]) {
      attachments.push(match[2]);
    }
  }
  return { text: raw.slice(0, start).trimEnd(), attachments };
}
