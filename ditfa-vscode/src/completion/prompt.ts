/**
 * What goes to the model for a Tab suggestion, and what comes back out of it.
 *
 * Pure on purpose: no editor, no network. Models are chatty about code, so a good
 * part of this file is cleaning their answers up.
 */

export interface CompletionRequest {
  /** Text before the cursor, cut at a line start so the model never sees half a line it was not meant to. */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
  language: string;
  /** Workspace-relative path, for the model's sake only. */
  path: string;
  /** Pieces of other open files that are likely to matter. */
  neighbors: { path: string; text: string }[];
}

export interface Window {
  prefix: string;
  suffix: string;
}

/** Everything before and after the cursor, trimmed to what fits and to whole lines. */
export function takeWindow(text: string, offset: number, before: number, after: number): Window {
  const start = Math.max(0, offset - before);
  let prefix = text.slice(start, offset);
  if (start > 0) {
    // Begin on a line boundary so a cut identifier never looks like code.
    const newline = prefix.indexOf("\n");
    prefix = newline === -1 ? prefix : prefix.slice(newline + 1);
  }

  const end = Math.min(text.length, offset + after);
  let suffix = text.slice(offset, end);
  if (end < text.length) {
    const newline = suffix.lastIndexOf("\n");
    suffix = newline === -1 ? suffix : suffix.slice(0, newline);
  }
  return { prefix, suffix };
}

/**
 * Whether a suggestion may run past the current line. With code still to come on
 * the line, a multi-line answer would split it, so only the rest of the line is
 * offered. Closing brackets and punctuation do not count as code to come.
 */
export function allowsMultiline(restOfLine: string): boolean {
  return /^[\s)\]}>,;:"'`]*$/.test(restOfLine);
}

/**
 * Whether typing here should ask for a suggestion by itself. Asking on every
 * keystroke is slow and spends tokens; a word started, or a block just opened,
 * is when a suggestion helps.
 */
export function worthSuggesting(linePrefix: string, previousLine: string): boolean {
  if (linePrefix.trim().length >= 2) {
    return true;
  }
  if (linePrefix.trim().length === 0) {
    return /[{(\[:=,>]\s*$|=>\s*$/.test(previousLine);
  }
  return false;
}

const SYSTEM = [
  "You are the code completion engine inside a code editor.",
  "The cursor is marked <CURSOR>. Write only the text that belongs at the cursor.",
  "No explanations, no markdown fences, no repeating the code around the cursor.",
  "Match the style, indentation and naming of the file. Stop when the thought is complete.",
  "If nothing useful belongs there, answer with nothing.",
].join(" ");

/** Chat-style request, for hosted providers and any model without fill-in-the-middle. */
export function chatMessages(request: CompletionRequest): { role: "system" | "user"; content: string }[] {
  const parts: string[] = [];
  for (const neighbor of request.neighbors) {
    parts.push(`Related file ${neighbor.path}:\n${neighbor.text}`);
  }
  parts.push(
    `File ${request.path || "(unsaved)"}${request.language ? ` (${request.language})` : ""}:\n${request.prefix}<CURSOR>${request.suffix}`,
  );
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Models whose names say they were trained to fill in the middle. */
const FIM_MODELS = /coder|codestral|starcoder|codellama|codegemma|granite-code|deepseek-coder/i;

export function supportsFim(model: string): boolean {
  return FIM_MODELS.test(model);
}

/** Model families that need the other token-limit name, or refuse a temperature. */
export function prefersCompletionTokens(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

const FENCE = /^\s*```[\w+-]*\s*\n/;
const SPECIAL_TOKENS = /<\|[a-z_0-9]+\|>|<\/?(?:fim_[a-z]+|PRE|SUF|MID|EOT)>/gi;

export interface CleanOptions {
  prefix: string;
  suffix: string;
  multiline: boolean;
  maxLines: number;
}

/** Turns a raw model answer into text that can be inserted at the cursor, or null. */
export function cleanCompletion(raw: string, options: CleanOptions): string | null {
  let text = raw.replace(SPECIAL_TOKENS, "").replace(/\r\n/g, "\n");

  // A fenced answer: keep what is inside.
  if (FENCE.test(text)) {
    text = text.replace(FENCE, "");
    const close = text.lastIndexOf("```");
    if (close !== -1) {
      text = text.slice(0, close);
    }
  }

  // The model started over from the beginning of the line instead of at the cursor,
  // with or without the indentation, and with or without the space before the cursor.
  const linePrefix = options.prefix.slice(options.prefix.lastIndexOf("\n") + 1);
  const echoed = linePrefix.trim();
  if (echoed.length >= 3) {
    const body = text.trimStart();
    if (body.startsWith(echoed)) {
      text = body.slice(echoed.length);
      if (/\s$/.test(linePrefix)) {
        text = text.replace(/^[ \t]+/, "");
      }
    }
  }

  // The answer ran on into code that is already there.
  const overlap = overlapWithSuffix(text, options.suffix);
  if (overlap > 0) {
    text = text.slice(0, text.length - overlap);
  }

  if (!options.multiline) {
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      text = text.slice(0, newline);
    }
  }

  const lines = text.split("\n");
  if (lines.length > options.maxLines) {
    text = lines.slice(0, options.maxLines).join("\n");
  }
  text = text.replace(/\s+$/, "");

  if (text.trim().length === 0) {
    return null;
  }
  // Suggesting what is already after the cursor is noise.
  if (options.suffix.trimStart().startsWith(text.trim())) {
    return null;
  }
  return text;
}

/** Length of the longest tail of `text` that is also the start of `suffix`, ignoring blank overlaps. */
function overlapWithSuffix(text: string, suffix: string): number {
  const limit = Math.min(text.length, suffix.length, 200);
  for (let length = limit; length > 0; length -= 1) {
    const head = suffix.slice(0, length);
    if (head.trim() !== "" && text.endsWith(head)) {
      return length;
    }
  }
  return 0;
}

/**
 * Files whose contents are secrets by convention. Suggestions never run in them
 * and never borrow from them, so a key in `.env` is not sent anywhere because of a
 * keystroke in another file.
 */
export function isSensitivePath(path: string): boolean {
  return /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[a-z]+)?|secrets?\.(json|ya?ml|toml|env)|[^\\/]+\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i.test(
    path,
  );
}
