import type { FileUpdateChange, ThreadItem } from "../protocol";
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
export function mapThreadItem(item: ThreadItem, at: number): ChatEntry | null {
  switch (item.type) {
    case "userMessage": {
      const text = item.content
        .map((input) => (input.type === "text" ? input.text : ""))
        .join("")
        .trim();
      const attachments = item.content
        .filter((input) => input.type === "mention" || input.type === "localImage")
        .map((input) => ("path" in input ? input.path : ""))
        .filter(Boolean);
      return { id: item.id, kind: "user", at, text, attachments };
    }

    case "agentMessage":
      return { id: item.id, kind: "assistant", at, text: item.text, streaming: false };

    case "reasoning": {
      const summary = [...item.summary, ...item.content].join("\n\n").trim();
      return { id: item.id, kind: "reasoning", at, summary, streaming: false };
    }

    case "plan":
      // Plan text is rendered from `turn/plan/updated`, not as a transcript row.
      return null;

    case "commandExecution":
      return {
        id: item.id,
        kind: "command",
        at,
        command: item.command,
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
      return {
        id: item.id,
        kind: "toolCall",
        at,
        title: `Viewed image ${item.path}`,
        detail: null,
        status: "completed",
        durationMs: null,
      };

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

export function summarizeChange(change: FileUpdateChange): FileChangeSummary {
  const { additions, deletions } = countDiffLines(change.diff);
  return {
    path: change.path,
    label: basename(change.path),
    kind: change.kind.type,
    movePath: change.kind.type === "update" ? change.kind.move_path : null,
    additions,
    deletions,
    diff: change.diff,
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
