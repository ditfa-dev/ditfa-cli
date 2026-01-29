/**
 * The contract between the extension host and the chat webview.
 *
 * Both sides import this file, so it must stay free of `vscode` and Node
 * imports — the webview bundle has neither.
 */

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "command"
  | "fileChange"
  | "toolCall"
  | "webSearch"
  | "notice"
  | "error";

export type CommandStatus = "running" | "completed" | "failed" | "aborted";
export type PatchStatus = "pending" | "applied" | "failed" | "aborted";

export interface FileChangeSummary {
  path: string;
  /** Basename, precomputed so the webview never has to touch path logic. */
  label: string;
  kind: "add" | "delete" | "update";
  movePath: string | null;
  additions: number;
  deletions: number;
  diff: string;
}

interface EntryBase {
  id: string;
  kind: EntryKind;
  /** Unix ms; used purely for stable ordering in the transcript. */
  at: number;
}

export interface UserEntry extends EntryBase {
  kind: "user";
  text: string;
  /** Workspace-relative paths the user attached alongside the message. */
  attachments: string[];
}

export interface AssistantEntry extends EntryBase {
  kind: "assistant";
  text: string;
  streaming: boolean;
}

export interface ReasoningEntry extends EntryBase {
  kind: "reasoning";
  summary: string;
  streaming: boolean;
}

export interface CommandEntry extends EntryBase {
  kind: "command";
  command: string;
  cwd: string;
  status: CommandStatus;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface FileChangeEntry extends EntryBase {
  kind: "fileChange";
  status: PatchStatus;
  changes: FileChangeSummary[];
}

export interface ToolCallEntry extends EntryBase {
  kind: "toolCall";
  title: string;
  detail: string | null;
  status: "running" | "completed" | "failed";
  durationMs: number | null;
}

export interface WebSearchEntry extends EntryBase {
  kind: "webSearch";
  query: string;
}

export interface NoticeEntry extends EntryBase {
  kind: "notice";
  text: string;
  tone: "info" | "warning";
}

export interface ErrorEntry extends EntryBase {
  kind: "error";
  message: string;
  details: string | null;
  retrying: boolean;
}

export type ChatEntry =
  | UserEntry
  | AssistantEntry
  | ReasoningEntry
  | CommandEntry
  | FileChangeEntry
  | ToolCallEntry
  | WebSearchEntry
  | NoticeEntry
  | ErrorEntry;

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TokenUsageView {
  used: number;
  contextWindow: number | null;
  percentUsed: number | null;
}

export type ApprovalRequest =
  | {
      kind: "command";
      id: string;
      command: string;
      cwd: string | null;
      reason: string | null;
      /** Present when the server offers to remember a broader allow rule. */
      canAlwaysAllow: boolean;
    }
  | {
      kind: "fileChange";
      id: string;
      reason: string | null;
      grantRoot: string | null;
      changes: FileChangeSummary[];
    }
  | {
      kind: "permissions";
      id: string;
      reason: string | null;
      cwd: string;
      summary: string;
    }
  | {
      kind: "userInput";
      id: string;
      question: string;
      options: { label: string; value: string }[];
      allowFreeform: boolean;
    };

export type ApprovalAnswer =
  | { id: string; kind: "command"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { id: string; kind: "fileChange"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { id: string; kind: "permissions"; decision: "accept" | "decline" }
  | { id: string; kind: "userInput"; value: string };

export type ConnectionState = "starting" | "ready" | "unavailable";

export interface SessionHeader {
  connection: ConnectionState;
  /** Populated when `connection` is `unavailable`. */
  connectionError: string | null;
  threadId: string | null;
  threadName: string | null;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string;
  sandboxMode: string;
  accountLabel: string | null;
  planLabel: string | null;
  /** 0-100, from the primary rate-limit window. */
  usagePercent: number | null;
}

export interface SessionState {
  header: SessionHeader;
  entries: ChatEntry[];
  plan: PlanStep[];
  planExplanation: string | null;
  tokenUsage: TokenUsageView | null;
  turnActive: boolean;
  approvals: ApprovalRequest[];
  showReasoning: boolean;
}

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: SessionState }
  | { type: "entries"; entries: ChatEntry[] }
  | { type: "entryUpsert"; entry: ChatEntry }
  | { type: "header"; header: SessionHeader }
  | { type: "plan"; plan: PlanStep[]; explanation: string | null }
  | { type: "tokenUsage"; usage: TokenUsageView | null }
  | { type: "turnActive"; active: boolean }
  | { type: "approvals"; approvals: ApprovalRequest[] }
  | { type: "composerInsert"; text: string }
  | { type: "focusComposer" }
  | { type: "fileSuggestions"; token: string; results: { label: string; path: string }[] };

/** Webview -> extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; attachments: string[] }
  | { type: "interrupt" }
  | { type: "newThread" }
  | { type: "resumeThread" }
  | { type: "approval"; answer: ApprovalAnswer }
  | { type: "openDiff"; entryId: string; path: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "selectModel" }
  | { type: "selectApprovalMode" }
  | { type: "signIn" }
  | { type: "showAccount" }
  | { type: "showLogs" }
  | { type: "retryConnection" }
  | { type: "requestFileSuggestions"; token: string; query: string }
  | { type: "copy"; text: string };
