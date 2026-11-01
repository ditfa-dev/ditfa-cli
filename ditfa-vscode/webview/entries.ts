import type {
  ApprovalRequest,
  ChatEntry,
  CommandEntry,
  FileChangeSummary,
} from "../src/session/types";
import { icons } from "./icons";
import { escapeHtml, renderMarkdown, stripAnsi, token, whole } from "./markdown";

/**
 * Pure rendering of transcript rows and approval cards. Everything that comes
 * from the model or the workspace goes through `escapeHtml` or `renderMarkdown`.
 */

export interface RenderContext {
  expanded: Set<string>;
  showReasoning: boolean;
  /** Code blocks per entry, for the copy buttons. */
  codeBlocks: Map<string, string[]>;
  turnActive: boolean;
}

export function renderEntry(entry: ChatEntry, ctx: RenderContext): string | null {
  switch (entry.kind) {
    case "user": {
      const chips = entry.attachments
        .map((label) => `<span class="mini-chip">${escapeHtml(label)}</span>`)
        .join("");
      const restore =
        entry.turnId && !ctx.turnActive
          ? `<button class="row-action" type="button" data-restore="${escapeHtml(entry.turnId)}" title="Go back to before this message">${icons.undo}<span>Restore</span></button>`
          : "";
      return `
        <div class="bubble" dir="auto">
          <div class="entry-text">${escapeHtml(entry.text).replace(/\n/g, "<br />")}</div>
          ${chips ? `<div class="chips">${chips}</div>` : ""}
        </div>
        ${restore}`;
    }

    case "assistant": {
      const rendered = renderMarkdown(entry.text);
      ctx.codeBlocks.set(entry.id, rendered.codeBlocks);
      return `<div class="markdown" dir="auto">${rendered.html}</div>`;
    }

    case "reasoning": {
      if (!ctx.showReasoning || (!entry.summary.trim() && !entry.streaming)) {
        return null;
      }
      const open = Boolean(entry.streaming) || ctx.expanded.has(entry.id);
      return `
        <button class="fold" type="button" data-toggle="${escapeHtml(entry.id)}" aria-expanded="${open}">
          <span class="caret${open ? " open" : ""}">${icons.caret}</span>
          <span>${entry.streaming ? "Thinking" : "Thought process"}</span>
        </button>
        ${open ? `<div class="reasoning-body" dir="auto">${escapeHtml(entry.summary).replace(/\n/g, "<br />")}</div>` : ""}`;
    }

    case "command":
      return renderCommand(entry, ctx);

    case "fileChange": {
      const totals = sumChanges(entry.changes);
      return `
        <div class="tool-card patch-${token(entry.status)}">
          <div class="tool-head">
            <span class="tool-icon">${icons.file}</span>
            <span class="tool-title">${entry.changes.length} file${entry.changes.length === 1 ? "" : "s"}</span>
            <span class="diffstat">${diffStat(totals.additions, totals.deletions)}</span>
            <span class="tool-status">${patchStatusLabel(entry.status)}</span>
          </div>
          <div class="file-list">${entry.changes.map((change) => renderFileRow(entry.id, change)).join("")}</div>
        </div>`;
    }

    case "toolCall":
      return `
        <div class="tool-line status-${token(entry.status)}">
          <span class="tool-icon">${icons.tool}</span>
          <span class="tool-title">${escapeHtml(entry.title)}</span>
          <span class="tool-status">${entry.status === "running" ? "running" : entry.status === "failed" ? "failed" : entry.durationMs ? formatDuration(entry.durationMs) : ""}</span>
        </div>
        ${entry.detail ? `<pre class="tool-output">${escapeHtml(entry.detail)}</pre>` : ""}`;

    case "webSearch":
      return `
        <div class="tool-line">
          <span class="tool-icon">${icons.globe}</span>
          <span class="tool-title">Searched the web for “${escapeHtml(entry.query)}”</span>
        </div>`;

    case "plan": {
      const rendered = renderMarkdown(entry.text);
      ctx.codeBlocks.set(entry.id, rendered.codeBlocks);
      return `<div class="plan-doc"><div class="plan-doc-head">${icons.plan}<span>Plan</span></div><div class="markdown" dir="auto">${rendered.html}</div></div>`;
    }

    case "turnStats": {
      const parts = [entry.model, `${formatTokens(entry.tokens)} tokens`];
      if (entry.durationMs) {
        parts.push(formatDuration(entry.durationMs));
      }
      return `<div class="turn-stats">${parts.filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ")}</div>`;
    }

    case "notice":
      return `<div class="notice notice-${token(entry.tone)}">${escapeHtml(entry.text)}</div>`;

    case "error": {
      const action = entry.action ? ERROR_ACTIONS[entry.action] : null;
      return `
        <div class="error-card${entry.retrying ? " retrying" : ""}">
          <div class="error-title">${entry.retrying ? `${escapeHtml(entry.message)}` : escapeHtml(entry.message)}</div>
          ${entry.details ? `<pre class="error-details">${escapeHtml(entry.details)}</pre>` : ""}
          ${action ? `<button type="button" class="ghost-button" data-error-action="${token(entry.action)}">${action}</button>` : ""}
        </div>`;
    }
  }
}

const ERROR_ACTIONS = {
  signIn: "Set up access",
  retry: "Try again",
  selectModel: "Change provider",
  compact: "Free up context",
};

function renderCommand(entry: CommandEntry, ctx: RenderContext): string {
  const output = stripAnsi(entry.output);
  const hasOutput = output.trim() !== "";
  const failed = entry.status === "failed" || (entry.exitCode ?? 0) !== 0;
  const open = entry.status === "running" || ctx.expanded.has(entry.id) !== failed;
  return `
    <div class="tool-card command status-${failed ? "failed" : token(entry.status)}">
      <button class="tool-head" type="button" ${hasOutput ? `data-toggle-inverse="${failed ? "1" : ""}" data-toggle="${escapeHtml(entry.id)}"` : ""} aria-expanded="${open}">
        <span class="tool-icon">${icons.terminal}</span>
        <span class="tool-title" title="${escapeHtml(entry.command)}">${entry.summary ? escapeHtml(entry.summary) : `<code>${escapeHtml(entry.command)}</code>`}</span>
        <span class="tool-status">${commandStatusLabel(entry)}</span>
      </button>
      ${open && hasOutput ? `<pre class="tool-output">${escapeHtml(tailLines(output, 400))}</pre>` : ""}
    </div>`;
}

export function commandOutputHtml(entry: CommandEntry): string {
  return escapeHtml(tailLines(stripAnsi(entry.output), 400));
}

export function renderFileRow(entryId: string, change: FileChangeSummary): string {
  const kindMark = change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M";
  return `
    <button class="file-row" type="button" data-diff-entry="${escapeHtml(entryId)}" data-diff-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
      <span class="file-kind kind-${token(change.kind)}">${kindMark}</span>
      <span class="file-name">${escapeHtml(change.label)}</span>
      <span class="diffstat">${diffStat(change.additions, change.deletions)}</span>
    </button>`;
}

export function sumChanges(changes: FileChangeSummary[]): { additions: number; deletions: number } {
  return changes.reduce(
    (acc, change) => ({
      additions: acc.additions + change.additions,
      deletions: acc.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function diffStat(additions: number, deletions: number): string {
  return `<span class="add">+${whole(additions)}</span> <span class="del">-${whole(deletions)}</span>`;
}

/** Shows what an edit will do right in the card, before anything reaches the disk. */
function renderDiffPreview(change: FileChangeSummary): string {
  const raw = change.diff.split("\n");
  const lines =
    change.kind === "update"
      ? raw.filter((line) => !/^(---|\+\+\+|diff --git|index )/.test(line))
      : raw.map((line) => `${change.kind === "add" ? "+" : "-"}${line}`);
  const shown = lines.slice(0, 200);
  const rows = shown
    .map((line) => {
      const type = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return `<div class="diff-line ${type}">${escapeHtml(line) || " "}</div>`;
    })
    .join("");
  const more = lines.length > shown.length ? `<div class="diff-line hunk">… ${lines.length - shown.length} more lines</div>` : "";
  return `<details class="diff-preview" open><summary>${escapeHtml(change.label)} <span class="diffstat">${diffStat(change.additions, change.deletions)}</span></summary><div class="diff-body">${rows}${more}</div></details>`;
}

export function renderApproval(request: ApprovalRequest): string {
  const head = (title: string, reason: string | null) => `
    <div class="approval-title">${icons.shield}<span>${title}</span></div>
    ${reason ? `<div class="approval-reason" dir="auto">${escapeHtml(reason)}</div>` : ""}`;
  const card = (kind: string, body: string) =>
    `<div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="${token(kind)}">${body}</div>`;

  switch (request.kind) {
    case "command":
      return card(
        "command",
        `${head("Run this command?", request.reason)}
        <pre class="approval-command">${escapeHtml(request.command)}</pre>
        ${request.cwd ? `<div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>` : ""}
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Run</button>
          ${request.canAlwaysAllow ? '<button data-decision="acceptForSession" type="button">Always this session</button>' : ""}
          <button data-decision="decline" type="button">Skip</button>
          <button class="ghost" data-decision="cancel" type="button">Stop</button>
        </div>`,
      );

    case "fileChange": {
      const totals = sumChanges(request.changes);
      return card(
        "fileChange",
        `${head(`Apply ${request.changes.length} file edit${request.changes.length === 1 ? "" : "s"}?`, request.reason)}
        <div class="approval-diffstat">${diffStat(totals.additions, totals.deletions)}</div>
        ${request.changes.map(renderDiffPreview).join("")}
        <div class="file-list">${request.changes.map((change) => renderFileRow(request.id, change)).join("")}</div>
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Apply</button>
          <button data-decision="acceptForSession" type="button">Always this session</button>
          <button data-decision="decline" type="button">Skip</button>
          <button class="ghost" data-decision="cancel" type="button">Stop</button>
        </div>`,
      );
    }

    case "permissions":
      return card(
        "permissions",
        `${head(`Grant ${escapeHtml(request.summary)}?`, request.reason)}
        <div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Grant</button>
          <button data-decision="decline" type="button">Deny</button>
        </div>`,
      );

    case "elicitation":
      return card(
        "elicitation",
        `${head(`${escapeHtml(request.server)} needs your input`, request.message)}
        ${request.url ? `<a class="approval-link" href="${escapeHtml(request.url)}">${escapeHtml(request.url)}</a>` : ""}
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Continue</button>
          <button data-decision="decline" type="button">Decline</button>
        </div>`,
      );

    case "userInput":
      return card(
        "userInput",
        `${head(escapeHtml(request.question), null)}
        <div class="approval-actions">
          ${request.options
            .map((option) => `<button data-value="${escapeHtml(option.value)}" type="button">${escapeHtml(option.label)}</button>`)
            .join("")}
        </div>
        ${
          request.allowFreeform
            ? `<div class="approval-freeform">
                 <input type="text" class="approval-input" placeholder="Type an answer…" dir="auto" />
                 <button class="primary" data-freeform="1" type="button">Reply</button>
               </div>`
            : ""
        }`,
      );
  }
}

export function commandStatusLabel(entry: Pick<CommandEntry, "status" | "exitCode" | "durationMs">): string {
  if (entry.status === "running") {
    return "running";
  }
  if (entry.status === "aborted") {
    return "stopped";
  }
  if (entry.exitCode) {
    return `exit ${whole(entry.exitCode)}`;
  }
  return entry.durationMs !== null ? formatDuration(entry.durationMs) : "";
}

function patchStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "waiting";
    case "applied":
      return "applied";
    case "aborted":
      return "skipped";
    default:
      return "failed";
  }
}

export function formatDuration(value: number): string {
  const ms = whole(value);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(value: number): string {
  const count = whole(value);
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Terminal output can be enormous; only the tail is interesting while scanning. */
function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) {
    return text;
  }
  return `… ${lines.length - max} earlier lines hidden\n${lines.slice(-max).join("\n")}`;
}

export function timeAgo(at: number, now = Date.now()): string {
  at = whole(at);
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString();
}
