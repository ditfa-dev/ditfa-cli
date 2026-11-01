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
  | "plan"
  | "turnStats"
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
  /** Unified diff for updates; the full file content for adds and deletes. */
  diff: string;
}

interface EntryBase {
  id: string;
  kind: EntryKind;
  /** Unix ms; used purely for stable ordering in the transcript. */
  at: number;
  /** The turn this entry belongs to, once the server has assigned one. */
  turnId?: string | null;
}

export interface UserEntry extends EntryBase {
  kind: "user";
  text: string;
  /** Display labels of the context attached alongside the message. */
  attachments: string[];
  /** Set on the local echo so the server's copy can replace it. */
  clientId?: string | null;
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
  /** The command the user would recognize, without the login-shell wrapper. */
  command: string;
  /** What the command does, when the server could work that out. */
  summary: string | null;
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

export interface PlanEntry extends EntryBase {
  kind: "plan";
  text: string;
}

/** Quiet footer under a finished turn: what actually ran and what it cost. */
export interface TurnStatsEntry extends EntryBase {
  kind: "turnStats";
  model: string | null;
  tokens: number;
  durationMs: number | null;
}

export interface NoticeEntry extends EntryBase {
  kind: "notice";
  text: string;
  tone: "info" | "warning";
}

export type ErrorAction = "signIn" | "retry" | "selectModel" | "compact";

export interface ErrorEntry extends EntryBase {
  kind: "error";
  message: string;
  details: string | null;
  retrying: boolean;
  /** The one thing that would actually fix this, when there is one. */
  action?: ErrorAction | null;
}

export type ChatEntry =
  | UserEntry
  | AssistantEntry
  | ReasoningEntry
  | CommandEntry
  | FileChangeEntry
  | ToolCallEntry
  | WebSearchEntry
  | PlanEntry
  | TurnStatsEntry
  | NoticeEntry
  | ErrorEntry;

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TokenUsageView {
  /** Tokens in the model's context as of the latest request. */
  used: number;
  /** Everything this thread has consumed so far, across all requests. */
  total: number;
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
    }
  | {
      kind: "elicitation";
      id: string;
      server: string;
      message: string;
      /** Set when the server wants the user to finish something in a browser. */
      url: string | null;
    };

export type ApprovalAnswer =
  | { id: string; kind: "command"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { id: string; kind: "fileChange"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { id: string; kind: "permissions"; decision: "accept" | "decline" }
  | { id: string; kind: "userInput"; value: string }
  | { id: string; kind: "elicitation"; decision: "accept" | "decline" };

export type ConnectionState =
  /** The engine is being located or started. */
  | "starting"
  | "ready"
  /** No `ditfa` binary anywhere; the panel offers to install one. */
  | "missingBinary"
  /** Downloading the engine; `SessionHeader.install` has the progress. */
  | "installing"
  | "unavailable";

/**
 * How much the agent may do without asking. This is the one choice users make;
 * it expands to an approval policy plus a sandbox the engine enforces, so "plan"
 * cannot write files however the model is prompted.
 */
export type AgentMode = "plan" | "ask" | "auto" | "full";

export interface InstallProgress {
  stage: "download" | "verify" | "unpack";
  /** 0-100, or null when the server did not report a size. */
  percent: number | null;
}

export interface SessionHeader {
  connection: ConnectionState;
  /** Populated when `connection` is `unavailable`. */
  connectionError: string | null;
  install: InstallProgress | null;
  threadId: string | null;
  threadName: string | null;
  cwd: string | null;
  workspaceOpen: boolean;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  mode: AgentMode;
  accountLabel: string | null;
  planLabel: string | null;
  /** 0-100, from the primary rate-limit window. */
  usagePercent: number | null;
  /** True until there is a way to reach a model: an account, a key, or a local server. */
  needsSetup: boolean;
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

/** Something the user attached to a message. */
export interface ContextAttachment {
  kind: "file" | "folder" | "selection" | "image";
  /** Absolute path, or a workspace-relative one for files. */
  path: string;
  label: string;
  /** 1-based, inclusive. Selections only. */
  range?: { start: number; end: number };
  /** The selected text. Selections only. */
  text?: string;
  language?: string;
  /** `data:` URL for pasted images. */
  dataUrl?: string;
}

export interface FileSuggestion {
  label: string;
  path: string;
  kind: "file" | "folder";
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  provider: string;
  active: boolean;
}

export interface ModelChoice {
  id: string;
  label: string;
  description: string | null;
  efforts: string[];
  isDefault: boolean;
}

export interface ModelCatalog {
  provider: string | null;
  providerLabel: string | null;
  models: ModelChoice[];
  /** Filled in when the catalog could not be fetched. */
  error: string | null;
}

export interface SetupOption {
  id: string;
  label: string;
  detail: string;
  kind: "account" | "apiKey" | "local";
  /** A key is already stored, or the local server answered. */
  ready: boolean;
}

export interface SlashCommand {
  id: string;
  label: string;
  detail: string;
  kind: "builtin" | "skill";
  /** Skills only: where the skill file lives. */
  path?: string;
}

export interface ActiveEditorInfo {
  path: string;
  label: string;
  selection: { start: number; end: number } | null;
}

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: SessionState }
  | { type: "entryUpsert"; entry: ChatEntry }
  | { type: "entryRemove"; id: string }
  | { type: "header"; header: SessionHeader }
  | { type: "plan"; plan: PlanStep[]; explanation: string | null }
  | { type: "tokenUsage"; usage: TokenUsageView | null }
  | { type: "turnActive"; active: boolean }
  | { type: "approvals"; approvals: ApprovalRequest[] }
  | { type: "composerInsert"; text: string }
  | { type: "composerAttach"; attachment: ContextAttachment }
  | { type: "composerSet"; text: string }
  | { type: "focusComposer" }
  | { type: "fileSuggestions"; token: string; results: FileSuggestion[] }
  | { type: "threads"; threads: ThreadSummary[]; query: string }
  | { type: "models"; catalog: ModelCatalog }
  | { type: "setupOptions"; options: SetupOption[] }
  | { type: "slashCommands"; commands: SlashCommand[] }
  | { type: "activeEditor"; editor: ActiveEditorInfo | null };

/** Webview -> extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      attachments: ContextAttachment[];
      skill?: { name: string; path: string } | null;
      includeActiveFile: boolean;
    }
  | { type: "interrupt" }
  | { type: "newThread" }
  | { type: "resumeThread"; threadId: string }
  | { type: "listThreads"; query: string }
  | { type: "renameThread"; threadId: string; title: string }
  | { type: "deleteThread"; threadId: string }
  | { type: "approval"; answer: ApprovalAnswer }
  | { type: "openDiff"; entryId: string; path: string }
  | { type: "reviewTurn"; turnId: string }
  | { type: "restoreCheckpoint"; turnId: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openExternal"; url: string }
  | { type: "selectModel"; model: string; effort: string | null }
  | { type: "selectProvider" }
  | { type: "requestModels" }
  | { type: "setMode"; mode: AgentMode }
  | { type: "signIn" }
  | { type: "setupProvider"; id: string }
  | { type: "showAccount" }
  | { type: "showLogs" }
  | { type: "openSettings" }
  | { type: "runDoctor" }
  | { type: "retryConnection" }
  | { type: "installEngine" }
  | { type: "locateBinary" }
  | { type: "openFolder" }
  | { type: "requestFileSuggestions"; token: string; query: string }
  | { type: "slashCommand"; id: string }
  | { type: "errorAction"; action: ErrorAction }
  | { type: "copy"; text: string }
  | { type: "webviewError"; message: string };
