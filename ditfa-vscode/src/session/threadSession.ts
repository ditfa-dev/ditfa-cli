import * as vscode from "vscode";

import type { AppServerClient } from "../client/appServerClient";
import type {
  SandboxPolicy,
  ServerNotification,
  ThreadStartResponse,
  TurnError,
  UserInput,
} from "../protocol";
import type { Logger } from "../util/logger";
import type { DitfaSettings } from "../util/settings";
import { mapThreadItem } from "./itemMapper";
import { mergeTranscript, type TranscriptStore } from "./transcriptStore";
import type {
  ChatEntry,
  ErrorAction,
  FileChangeSummary,
  PlanStep,
  TokenUsageView,
  UserEntry,
} from "./types";

export interface ThreadContext {
  threadId: string;
  cwd: string;
  model: string;
  provider: string;
  reasoningEffort: string | null;
  name: string | null;
}

export interface SessionSnapshot {
  entries: ChatEntry[];
  plan: PlanStep[];
  planExplanation: string | null;
  tokenUsage: TokenUsageView | null;
  turnActive: boolean;
  context: ThreadContext | null;
}

export interface TurnOptions {
  settings: DitfaSettings;
  sandboxPolicy: SandboxPolicy;
}

/** Output kept per command. A build log must not become the extension's memory use. */
const MAX_OUTPUT_CHARS = 200_000;
/** The same command this many times in one turn means the agent is stuck. */
const LOOP_LIMIT = 6;

/**
 * Owns one ditfa thread: its transcript, the active turn, and the projection of
 * server notifications into transcript entries.
 *
 * Streaming deltas arrive before the matching `item/completed`, so entries are
 * created optimistically on first delta and then reconciled when the completed
 * item lands. Ordering is by first appearance, which matches how app-server
 * emits items.
 */
export class ThreadSession implements vscode.Disposable {
  private readonly entryOrder: string[] = [];
  private readonly entries = new Map<string, ChatEntry>();

  private context: ThreadContext | null = null;
  private plan: PlanStep[] = [];
  private planExplanation: string | null = null;
  private tokenUsage: TokenUsageView | null = null;
  private activeTurnId: string | null = null;
  /** Set between `turn/start` going out and `turn/started` coming back. */
  private turnStarting = false;

  /** Turn ids in the order they ran, so a checkpoint knows how far to roll back. */
  private turnOrder: string[] = [];
  private turnStartTokens = 0;
  private turnModel: string | null = null;
  private retryEntryId: string | null = null;
  /** The last fatal error, so `turn/completed` repeating it does not add a second card. */
  private lastErrorMessage: string | null = null;
  private lastUserMessage: { text: string; input: UserInput[] } | null = null;
  private commandCounts = new Map<string, number>();
  private clientMessageCounter = 0;

  private readonly entryEmitter = new vscode.EventEmitter<ChatEntry>();
  private readonly removeEmitter = new vscode.EventEmitter<string>();
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  private readonly planEmitter = new vscode.EventEmitter<{
    plan: PlanStep[];
    explanation: string | null;
  }>();
  private readonly usageEmitter = new vscode.EventEmitter<TokenUsageView | null>();
  private readonly turnEmitter = new vscode.EventEmitter<boolean>();
  private readonly contextEmitter = new vscode.EventEmitter<ThreadContext | null>();
  private readonly loopEmitter = new vscode.EventEmitter<string>();

  readonly onEntry = this.entryEmitter.event;
  readonly onRemoveEntry = this.removeEmitter.event;
  readonly onReset = this.resetEmitter.event;
  readonly onPlan = this.planEmitter.event;
  readonly onUsage = this.usageEmitter.event;
  readonly onTurnActiveChanged = this.turnEmitter.event;
  readonly onContextChanged = this.contextEmitter.event;
  /** Fires with the command the agent keeps repeating. */
  readonly onLoopDetected = this.loopEmitter.event;

  constructor(
    private readonly client: AppServerClient,
    private readonly logger: Logger,
    private readonly store: TranscriptStore,
  ) {}

  get threadId(): string | null {
    return this.context?.threadId ?? null;
  }

  get turnActive(): boolean {
    return this.activeTurnId !== null || this.turnStarting;
  }

  /** Tokens this turn has consumed so far. */
  get turnTokens(): number {
    return (this.tokenUsage?.total ?? 0) - this.turnStartTokens;
  }

  snapshot(): SessionSnapshot {
    return {
      entries: this.orderedEntries(),
      plan: this.plan,
      planExplanation: this.planExplanation,
      tokenUsage: this.tokenUsage,
      turnActive: this.turnActive,
      context: this.context,
    };
  }

  async start(settings: DitfaSettings, cwd: string | undefined): Promise<ThreadContext> {
    this.reset();
    const response = await this.client.request("thread/start", {
      cwd: cwd ?? null,
      model: settings.model || null,
      modelProvider: settings.provider || null,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandboxMode,
    });
    return this.adoptThread(response);
  }

  async resume(threadId: string, settings: DitfaSettings, cwd: string | undefined): Promise<ThreadContext> {
    this.reset();
    const response = await this.client.request("thread/resume", {
      threadId,
      cwd: cwd ?? null,
      model: settings.model || null,
      modelProvider: settings.provider || null,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandboxMode,
    });

    const stored = await this.store.load(threadId);
    const turns = response.thread.turns;
    this.turnOrder = turns.map((turn) => turn.id);
    for (const entry of mergeTranscript(turns, stored?.entries ?? null)) {
      this.insert(entry);
    }
    if (stored) {
      this.plan = stored.plan;
      this.planExplanation = stored.planExplanation;
      this.tokenUsage = stored.tokenUsage;
    }
    return this.adoptThread(response);
  }

  /** Forgets the thread without touching the server; the next message creates a new one. */
  clear(): void {
    this.reset();
    this.contextEmitter.fire(null);
  }

  /**
   * Sends a user message. If a turn is already running the text is steered into
   * it instead of queuing a second turn, which is what the TUI does and what
   * users expect when they type mid-run.
   */
  async send(
    echo: { text: string; attachments: string[] },
    input: UserInput[],
    options: TurnOptions,
  ): Promise<void> {
    const threadId = this.context?.threadId;
    if (!threadId) {
      throw new Error("No active ditfa thread.");
    }
    const clientId = `vscode-${Date.now()}-${++this.clientMessageCounter}`;
    this.lastUserMessage = { text: echo.text, input };

    // Echo the message immediately: app-server only emits the user item once the
    // turn starts, and a message that vanishes on send feels broken. The server's
    // copy carries `clientId` back and takes over this row.
    this.upsert({
      id: clientId,
      kind: "user",
      at: Date.now(),
      text: echo.text,
      attachments: echo.attachments,
      clientId,
      turnId: this.activeTurnId,
    });

    try {
      if (this.activeTurnId) {
        await this.client.request("turn/steer", {
          threadId,
          expectedTurnId: this.activeTurnId,
          clientUserMessageId: clientId,
          input,
        });
        return;
      }

      this.setTurnStarting(true);
      const { settings, sandboxPolicy } = options;
      await this.client.request("turn/start", {
        threadId,
        clientUserMessageId: clientId,
        input,
        model: settings.model || null,
        effort: settings.reasoningEffort,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy,
      });
    } catch (error) {
      this.setTurnStarting(false);
      this.remove(clientId);
      throw error;
    }
  }

  /** Sends the last message again, for the Retry button on a failed turn. */
  async resend(options: TurnOptions): Promise<void> {
    if (this.lastUserMessage) {
      const { text, input } = this.lastUserMessage;
      await this.send({ text, attachments: [] }, input, options);
    }
  }

  async interrupt(): Promise<void> {
    const threadId = this.context?.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) {
      return;
    }
    await this.client.request("turn/interrupt", { threadId, turnId });
  }

  async compact(): Promise<void> {
    const threadId = this.context?.threadId;
    if (threadId) {
      await this.client.request("thread/compact/start", { threadId });
    }
  }

  async review(): Promise<void> {
    const threadId = this.context?.threadId;
    if (threadId) {
      await this.client.request("review/start", {
        threadId,
        target: { type: "uncommittedChanges" },
      });
    }
  }

  /** Applied file changes from `turnId` onward, oldest first. */
  changesSince(turnId: string): FileChangeSummary[] {
    const from = this.turnOrder.indexOf(turnId);
    const turns = new Set(from === -1 ? [turnId] : this.turnOrder.slice(from));
    const changes: FileChangeSummary[] = [];
    for (const entry of this.orderedEntries()) {
      if (entry.kind === "fileChange" && entry.status === "applied" && turns.has(entry.turnId ?? "")) {
        changes.push(...entry.changes);
      }
    }
    return changes;
  }

  /** Changes made by exactly one turn. */
  changesIn(turnId: string): FileChangeSummary[] {
    return this.orderedEntries().flatMap((entry) =>
      entry.kind === "fileChange" && entry.status === "applied" && entry.turnId === turnId
        ? entry.changes
        : [],
    );
  }

  get latestTurnId(): string | null {
    return this.turnOrder[this.turnOrder.length - 1] ?? null;
  }

  userEntryFor(turnId: string): UserEntry | null {
    const entry = this.orderedEntries().find(
      (candidate) => candidate.kind === "user" && candidate.turnId === turnId,
    );
    return entry?.kind === "user" ? entry : null;
  }

  /**
   * Drops `turnId` and everything after it from the conversation. Files are the
   * caller's job; the server only rewinds its own history.
   */
  async rollbackTo(turnId: string): Promise<void> {
    const threadId = this.context?.threadId;
    const index = this.turnOrder.indexOf(turnId);
    if (!threadId || index === -1) {
      return;
    }
    const dropped = new Set(this.turnOrder.slice(index));
    await this.client.request("thread/rollback", { threadId, numTurns: dropped.size });

    this.turnOrder = this.turnOrder.slice(0, index);
    for (const entry of this.orderedEntries()) {
      if (entry.turnId && dropped.has(entry.turnId)) {
        this.entries.delete(entry.id);
      }
    }
    const kept = this.entryOrder.filter((id) => this.entries.has(id));
    this.entryOrder.length = 0;
    this.entryOrder.push(...kept);
    this.plan = [];
    this.planExplanation = null;
    void this.persist();
    this.resetEmitter.fire();
  }

  /** Routes a server notification into transcript state. Unknown methods are ignored. */
  handleNotification(notification: ServerNotification): void {
    const params = notification.params as Record<string, unknown> | undefined;
    // Notifications for other threads (sub-agents, background work) must not
    // leak into this transcript.
    const threadId = params && typeof params.threadId === "string" ? params.threadId : null;
    if (threadId && this.context && threadId !== this.context.threadId) {
      return;
    }

    switch (notification.method) {
      case "thread/started":
        this.setContextFrom(notification.params.thread.id, notification.params.thread.name);
        break;

      case "thread/name/updated":
        this.setContextFrom(notification.params.threadId, notification.params.threadName ?? null);
        break;

      case "turn/started":
        this.activeTurnId = notification.params.turn.id;
        this.turnStarting = false;
        this.turnOrder.push(notification.params.turn.id);
        this.turnStartTokens = this.tokenUsage?.total ?? 0;
        this.turnModel = this.context?.model ?? null;
        this.lastErrorMessage = null;
        this.commandCounts.clear();
        this.plan = [];
        this.planExplanation = null;
        this.planEmitter.fire({ plan: this.plan, explanation: null });
        this.turnEmitter.fire(true);
        break;

      case "turn/completed": {
        const turn = notification.params.turn;
        this.activeTurnId = null;
        this.turnStarting = false;
        this.clearRetry();
        this.finalizeStreaming();
        if (turn.error && turn.error.message !== this.lastErrorMessage) {
          this.pushError(turn.error, turn.id);
        }
        if (turn.status === "completed" && this.turnTokens > 0) {
          this.upsert({
            id: `stats-${turn.id}`,
            kind: "turnStats",
            at: Date.now(),
            turnId: turn.id,
            model: this.turnModel,
            tokens: this.turnTokens,
            durationMs: turn.durationMs,
          });
        }
        this.turnEmitter.fire(false);
        void this.persist();
        break;
      }

      case "item/started":
      case "item/completed": {
        const { item, turnId } = notification.params;
        const entry = mapThreadItem(item, Date.now(), turnId);
        if (!entry) {
          break;
        }
        this.clearRetry();
        if (entry.kind === "user" && this.adoptEcho(entry)) {
          break;
        }
        this.upsert(this.preserveStreamedText(entry));
        if (entry.kind === "command" && notification.method === "item/started") {
          this.trackCommand(entry.command);
        }
        break;
      }

      case "item/agentMessage/delta":
        this.clearRetry();
        this.appendAssistantDelta(
          notification.params.itemId,
          notification.params.turnId,
          notification.params.delta,
        );
        break;

      case "item/reasoning/summaryTextDelta":
        this.appendReasoningDelta(
          notification.params.itemId,
          notification.params.turnId,
          notification.params.delta,
        );
        break;

      case "item/reasoning/summaryPartAdded":
        this.appendReasoningDelta(notification.params.itemId, notification.params.turnId, "\n\n");
        break;

      case "item/commandExecution/outputDelta":
        this.appendCommandOutput(notification.params.itemId, notification.params.delta);
        break;

      case "turn/plan/updated":
        this.plan = notification.params.plan.map((step) => ({
          step: step.step,
          status: step.status === "inProgress" ? "in_progress" : step.status,
        }));
        this.planExplanation = notification.params.explanation;
        this.planEmitter.fire({ plan: this.plan, explanation: this.planExplanation });
        break;

      case "thread/tokenUsage/updated": {
        const usage = notification.params.tokenUsage;
        // `total` adds up every request ever made; only `last` says what is in
        // the context window now.
        const used = usage.last.totalTokens;
        const window = usage.modelContextWindow;
        this.tokenUsage = {
          used,
          total: usage.total.totalTokens,
          contextWindow: window,
          percentUsed: window && window > 0 ? Math.min(100, (used / window) * 100) : null,
        };
        this.usageEmitter.fire(this.tokenUsage);
        break;
      }

      case "thread/compacted":
        this.pushNotice("Context compacted to free up the window", "info");
        break;

      case "error":
        if (notification.params.willRetry) {
          this.showRetry(notification.params.error, notification.params.turnId);
        } else {
          this.clearRetry();
          this.lastErrorMessage = notification.params.error.message;
          this.pushError(notification.params.error, notification.params.turnId);
        }
        break;

      case "warning":
      case "configWarning":
      case "guardianWarning":
        this.pushNotice(String((notification.params as { message: string }).message), "warning");
        break;

      case "model/rerouted":
        this.turnModel = notification.params.toModel;
        this.pushNotice(
          `Switched from ${notification.params.fromModel} to ${notification.params.toModel} for this request.`,
          "info",
        );
        break;

      default:
        break;
    }
  }

  /** Adds a host-side notice to the transcript, such as a restart or a guard tripping. */
  notice(text: string, tone: "info" | "warning" = "info"): void {
    this.pushNotice(text, tone);
  }

  dispose(): void {
    this.entryEmitter.dispose();
    this.removeEmitter.dispose();
    this.resetEmitter.dispose();
    this.planEmitter.dispose();
    this.usageEmitter.dispose();
    this.turnEmitter.dispose();
    this.contextEmitter.dispose();
    this.loopEmitter.dispose();
  }

  private orderedEntries(): ChatEntry[] {
    return this.entryOrder
      .map((id) => this.entries.get(id))
      .filter((entry): entry is ChatEntry => entry !== undefined);
  }

  private setTurnStarting(starting: boolean): void {
    if (this.turnStarting !== starting) {
      this.turnStarting = starting;
      this.turnEmitter.fire(this.turnActive);
    }
  }

  private async persist(): Promise<void> {
    const threadId = this.context?.threadId;
    if (threadId) {
      await this.store.save({
        threadId,
        entries: this.orderedEntries(),
        plan: this.plan,
        planExplanation: this.planExplanation,
        tokenUsage: this.tokenUsage,
      });
    }
  }

  private adoptThread(response: ThreadStartResponse): ThreadContext {
    const context: ThreadContext = {
      threadId: response.thread.id,
      cwd: response.cwd,
      model: response.model,
      provider: response.modelProvider,
      reasoningEffort: response.reasoningEffort,
      name: response.thread.name,
    };
    this.context = context;
    this.contextEmitter.fire(context);
    this.resetEmitter.fire();
    this.logger.info(
      `thread ${context.threadId} ready (${context.provider}/${context.model}) in ${context.cwd}`,
    );
    return context;
  }

  private setContextFrom(threadId: string, name: string | null): void {
    if (!this.context) {
      return;
    }
    if (this.context.threadId !== threadId && this.context.threadId) {
      return;
    }
    this.context = { ...this.context, name };
    this.contextEmitter.fire(this.context);
  }

  private reset(): void {
    this.entryOrder.length = 0;
    this.entries.clear();
    this.plan = [];
    this.planExplanation = null;
    this.tokenUsage = null;
    this.activeTurnId = null;
    this.turnStarting = false;
    this.context = null;
    this.turnOrder = [];
    this.turnStartTokens = 0;
    this.retryEntryId = null;
    this.lastErrorMessage = null;
    this.lastUserMessage = null;
    this.commandCounts.clear();
    this.resetEmitter.fire();
  }

  private insert(entry: ChatEntry): void {
    if (!this.entries.has(entry.id)) {
      this.entryOrder.push(entry.id);
    }
    this.entries.set(entry.id, entry);
  }

  private upsert(entry: ChatEntry): void {
    this.insert(entry);
    this.entryEmitter.fire(entry);
  }

  private remove(id: string): void {
    if (this.entries.delete(id)) {
      const index = this.entryOrder.indexOf(id);
      if (index !== -1) {
        this.entryOrder.splice(index, 1);
      }
      this.removeEmitter.fire(id);
    }
  }

  /** Swaps the local echo for the server's copy, keeping its place in the transcript. */
  private adoptEcho(entry: UserEntry): boolean {
    if (this.entries.has(entry.id)) {
      // `item/completed` for a message already adopted on `item/started`.
      return true;
    }
    const clientId = entry.clientId;
    const echo = clientId ? this.entries.get(clientId) : undefined;
    if (!clientId || echo?.kind !== "user") {
      return false;
    }
    // The echo's attachments are the labels the user picked; keep those.
    const adopted: UserEntry = { ...echo, id: entry.id, turnId: entry.turnId ?? echo.turnId ?? null };
    this.entries.delete(clientId);
    this.entries.set(entry.id, adopted);
    const index = this.entryOrder.indexOf(clientId);
    if (index !== -1) {
      this.entryOrder[index] = entry.id;
    }
    this.removeEmitter.fire(clientId);
    this.entryEmitter.fire(adopted);
    return true;
  }

  private trackCommand(command: string): void {
    const seen = (this.commandCounts.get(command) ?? 0) + 1;
    this.commandCounts.set(command, seen);
    if (seen === LOOP_LIMIT) {
      this.loopEmitter.fire(command);
    }
  }

  /**
   * `item/started` for a message arrives with empty text and would otherwise
   * blank out text already streamed in via deltas.
   */
  private preserveStreamedText(entry: ChatEntry): ChatEntry {
    const existing = this.entries.get(entry.id);
    if (!existing) {
      return entry;
    }
    if (entry.kind === "assistant" && existing.kind === "assistant" && !entry.text) {
      return { ...entry, text: existing.text, streaming: existing.streaming };
    }
    if (entry.kind === "reasoning" && existing.kind === "reasoning" && !entry.summary) {
      return { ...entry, summary: existing.summary, streaming: existing.streaming };
    }
    if (entry.kind === "command" && existing.kind === "command" && !entry.output) {
      return { ...entry, output: existing.output };
    }
    return entry;
  }

  private appendAssistantDelta(itemId: string, turnId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "assistant") {
      this.upsert({ ...existing, text: existing.text + delta, streaming: true });
      return;
    }
    this.upsert({ id: itemId, kind: "assistant", at: Date.now(), turnId, text: delta, streaming: true });
  }

  private appendReasoningDelta(itemId: string, turnId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "reasoning") {
      this.upsert({ ...existing, summary: existing.summary + delta, streaming: true });
      return;
    }
    this.upsert({ id: itemId, kind: "reasoning", at: Date.now(), turnId, summary: delta, streaming: true });
  }

  private appendCommandOutput(itemId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "command") {
      const output = existing.output + delta;
      this.upsert({
        ...existing,
        output: output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output,
      });
    }
  }

  /** Clears streaming flags left behind when a turn ends mid-stream. */
  private finalizeStreaming(): void {
    for (const id of this.entryOrder) {
      const entry = this.entries.get(id);
      if (!entry) {
        continue;
      }
      if (entry.kind === "assistant" && entry.streaming) {
        this.upsert({ ...entry, streaming: false });
      } else if (entry.kind === "reasoning" && entry.streaming) {
        this.upsert({ ...entry, streaming: false });
      } else if (entry.kind === "command" && entry.status === "running") {
        this.upsert({ ...entry, status: "aborted" });
      }
    }
  }

  /** One row for the whole retry sequence, updated in place. */
  private showRetry(error: TurnError, turnId: string): void {
    const id = this.retryEntryId ?? `retry-${turnId}`;
    this.retryEntryId = id;
    this.upsert({
      id,
      kind: "error",
      at: Date.now(),
      turnId,
      message: error.message,
      details: error.additionalDetails,
      retrying: true,
    });
  }

  private clearRetry(): void {
    if (this.retryEntryId) {
      this.remove(this.retryEntryId);
      this.retryEntryId = null;
    }
  }

  private pushError(error: TurnError, turnId: string): void {
    this.upsert({
      id: `error-${Date.now()}-${this.entryOrder.length}`,
      kind: "error",
      at: Date.now(),
      turnId,
      message: error.message,
      details: error.additionalDetails,
      retrying: false,
      action: suggestAction(error),
    });
  }

  private pushNotice(text: string, tone: "info" | "warning"): void {
    this.upsert({
      id: `notice-${Date.now()}-${this.entryOrder.length}`,
      kind: "notice",
      at: Date.now(),
      turnId: this.activeTurnId,
      text,
      tone,
    });
  }
}

/** Maps an engine error onto the one action that would fix it. */
function suggestAction(error: TurnError): ErrorAction {
  const info = JSON.stringify(error.ditfaErrorInfo ?? "").toLowerCase();
  if (info.includes("unauthorized")) {
    return "signIn";
  }
  if (info.includes("contextwindowexceeded")) {
    return "compact";
  }
  if (info.includes("usagelimit") || info.includes("usagenotincluded") || info.includes("modelcap")) {
    return "selectModel";
  }
  return "retry";
}
