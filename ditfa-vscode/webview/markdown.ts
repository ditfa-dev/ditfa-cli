/**
 * Small Markdown renderer for assistant messages.
 *
 * Everything is HTML-escaped before any markup is introduced, so model output
 * can never inject nodes into the webview. The grammar covered is deliberately
 * narrow — fenced code, inline code, headings, lists, blockquotes, emphasis, and
 * links — because anything richer is a liability under a strict CSP.
 */

const SENTINEL = "\u0000";

export interface RenderedMarkdown {
  html: string;
  /** Code block contents in document order, for wiring up copy buttons. */
  codeBlocks: string[];
}

export function renderMarkdown(source: string): RenderedMarkdown {
  const codeBlocks: string[] = [];
  const lines = source.split("\n");
  const out: string[] = [];

  let index = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // consume closing fence
      const code = body.join("\n");
      const blockIndex = codeBlocks.length;
      codeBlocks.push(code);
      out.push(
        `<div class="code-block">` +
          `<div class="code-block-head"><span class="code-lang">${escapeHtml(language || "text")}</span>` +
          `<button class="code-copy" type="button" data-copy-index="${blockIndex}">Copy</button></div>` +
          `<pre><code>${escapeHtml(code)}</code></pre></div>`,
      );
      continue;
    }

    if (line.trim() === "") {
      closeList();
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = (heading[1] ?? "#").length + 2;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1] ?? "")}</blockquote>`);
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(bullet[1] ?? "")}</li>`);
      index += 1;
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(numbered[1] ?? "")}</li>`);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out.push("<hr />");
      index += 1;
      continue;
    }

    // Consume consecutive plain lines into one paragraph so wrapped prose does
    // not render as a stack of separate blocks.
    closeList();
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (
        next.trim() === "" ||
        /^```/.test(next) ||
        /^#{1,4}\s/.test(next) ||
        /^\s*[-*+]\s/.test(next) ||
        /^\s*\d+[.)]\s/.test(next) ||
        /^>/.test(next)
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }

  closeList();
  return { html: out.join(""), codeBlocks };
}

function inline(text: string): string {
  let result = escapeHtml(text);

  // Inline code is extracted first so emphasis rules never rewrite its
  // contents. The placeholder uses NUL, which escapeHtml strips from input.
  const codeSpans: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  });

  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\n/g, "<br />");

  const placeholder = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");
  return result.replace(placeholder, (_match, index: string) => {
    return `<code>${codeSpans[Number(index)] ?? ""}</code>`;
  });
}

export function escapeHtml(value: string): string {
  return value
    .split(SENTINEL)
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strips ANSI escape sequences from captured terminal output. Covers CSI
 * sequences (colors, cursor moves) and OSC sequences (window titles), which is
 * everything a build tool realistically emits.
 */
export function stripAnsi(value: string): string {
  const csi = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
  const osc = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
  return value.replace(csi, "").replace(osc, "").replace(/\r/g, "");
}

