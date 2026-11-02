import type { CommandAction, FileUpdateChange, ThreadItem } from "../protocol";
import { parseUserText } from "./promptContext";
import type {
  ChatEntry,
  CommandStatus,
  FileChangeSummary,
  PatchStatus,
} from "./types";

/**
 * Projects an app-server `ThreadItem` onto the flatter shape the transcript
 * renders. Item variants the UI has no dedicated affordance for collapse into
 * a `toolCall` entry rather than being dropped, so the user still sees that
 * something happened.
 */
export function mapThreadItem(item: ThreadItem, at: number, turnId?: string | null): ChatEntry | null {
  const entry = mapItem(item, at);
  return entry ? { ...entry, turnId: turnId ?? null } : null;
}

function mapItem(item: ThreadItem, at: number): ChatEntry | null {
  switch (item.type) {
    case "userMessage": {
      const raw = item.content
        .map((input) => (input.type === "text" ? input.text : ""))
        .join("")
        .trim();
      const parsed = parseUserText(raw);
      const images = item.content.flatMap((input) => {
        if (input.type === "localImage") {
          return [basename(input.path)];
        }
        return input.type === "image" ? ["image"] : [];
      });
      return {
        id: item.id,
        kind: "user",
        at,
        text: parsed.text,
        attachments: [...parsed.attachments, ...images],
        clientId: item.clientId,
      };
    }

    case "agentMessage":
      return { id: item.id, kind: "assistant", at, text: item.text, streaming: false };

    case "reasoning": {
      const summary = [...item.summary, ...item.content].join("\n\n").trim();
      return { id: item.id, kind: "reasoning", at, summary, streaming: false };
    }

    case "plan":
      return { id: item.id, kind: "plan", at, text: item.text };

    case "commandExecution":
      return {
        id: item.id,
        kind: "command",
        at,
        command: displayCommand(item.command),
        summary: describeActions(item.commandActions),
        cwd: item.cwd,
        status: mapCommandStatus(item.status),
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };

    case "fileChange":
      return {
        id: item.id,
        kind: "fileChange",
        at,
        status: mapPatchStatus(item.status),
        changes: item.changes.map(summarizeChange),
      };

    case "mcpToolCall":
      return {
        id: item.id,
        kind: "toolCall",
        at,
        title: `${item.server} · ${item.tool}`,
        detail: item.error?.message ?? null,
        status: item.status === "inProgress" ? "running" : item.status,
        durationMs: item.durationMs,
      };

    case "dynamicToolCall":
      return {
        id: item.id,
        kind: "toolCall",
        at,
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        detail: null,
        status: item.status === "inProgress" ? "running" : item.success === false ? "failed" : "completed",
        durationMs: item.durationMs,
      };

    case "webSearch":
      return { id: item.id, kind: "webSearch", at, query: describeWebSearch(item) };

    case "imageView":
      return staticTool(item.id, at, `Viewed image ${basename(item.path)}`);

    case "imageGeneration":
      return staticTool(item.id, at, "Generated an image");

    case "collabAgentToolCall":
    case "subAgentActivity":
      return staticTool(item.id, at, "Delegated work to a sub-agent");

    case "enteredReviewMode":
      return { id: item.id, kind: "notice", at, tone: "info", text: `Started review: ${item.review}` };

    case "exitedReviewMode":
      return { id: item.id, kind: "notice", at, tone: "info", text: "Review finished" };

    case "contextCompaction":
      return {
        id: item.id,
        kind: "notice",
        at,
        tone: "info",
        text: "Context compacted to free up the window",
      };

    default:
      return null;
  }
}

function staticTool(id: string, at: number, title: string): ChatEntry {
  return { id, kind: "toolCall", at, title, detail: null, status: "completed", durationMs: null };
}

/**
 * The server reports the shell invocation it actually spawned. Users did not
 * type `/bin/zsh -lc '…'`, so show the command inside it.
 */
export function displayCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:bash|zsh|sh|dash)\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!match?.[1]) {
    return command;
  }
  const inner = match[1].trim();
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    return inner.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    return inner.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return inner;
}

function describeActions(actions: CommandAction[] | null | undefined): string | null {
  if (!actions || actions.length !== 1) {
    return null;
  }
  const action = actions[0];
  switch (action?.type) {
    case "read":
      return `Read ${action.name}`;
    case "listFiles":
      return `Listed ${action.path ?? "files"}`;
    case "search":
      return action.query ? `Searched for “${action.query}”` : "Searched the workspace";
    default:
      return null;
  }
}

function describeWebSearch(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  const action = (item as { action?: unknown }).action;
  if (action && typeof action === "object" && "query" in action) {
    const query = (action as { query?: unknown }).query;
    if (typeof query === "string") {
      return query;
    }
  }
  return "web search";
}

const MOVE_SUFFIX = /\n*Moved to: [^\n]*\s*$/;

export function summarizeChange(change: FileUpdateChange): FileChangeSummary {
  const kind = change.kind.type;
  // Adds and deletes carry the file's content, not a diff: every line counts.
  const counts =
    kind === "update"
      ? countDiffLines(change.diff)
      : kind === "add"
        ? { additions: countContentLines(change.diff), deletions: 0 }
        : { additions: 0, deletions: countContentLines(change.diff) };

  return {
    path: change.path,
    label: basename(change.path),
    kind,
    movePath: change.kind.type === "update" ? change.kind.move_path : null,
    ...counts,
    // The server appends a human note after a moved file's hunks.
    diff: kind === "update" ? change.diff.replace(MOVE_SUFFIX, "\n") : change.diff,
  };
}

/**
 * Counts changed lines in a unified diff, skipping the `+++`/`---` file headers
 * so a one-line edit does not report two extra changes.
 */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function mapCommandStatus(status: "inProgress" | "completed" | "failed" | "declined"): CommandStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "declined":
      return "aborted";
    default:
      return status;
  }
}

function mapPatchStatus(status: "inProgress" | "completed" | "failed" | "declined"): PatchStatus {
  switch (status) {
    case "inProgress":
      return "pending";
    case "completed":
      return "applied";
    case "declined":
      return "aborted";
    default:
      return "failed";
  }
}
