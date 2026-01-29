import * as vscode from "vscode";

import type { AppServerClient } from "../client/appServerClient";
import type {
  ServerNotification,
  ThreadStartResponse,
  UserInput,
} from "../protocol";
import type { Logger } from "../util/logger";
import type { DitfaSettings } from "../util/settings";
import { mapThreadItem } from "./itemMapper";
import type { ChatEntry, PlanStep, TokenUsageView } from "./types";

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

  private readonly entryEmitter = new vscode.EventEmitter<ChatEntry>();
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  private readonly planEmitter = new vscode.EventEmitter<{
    plan: PlanStep[];
    explanation: string | null;
  }>();
  private readonly usageEmitter = new vscode.EventEmitter<TokenUsageView | null>();
  private readonly turnEmitter = new vscode.EventEmitter<boolean>();
  private readonly contextEmitter = new vscode.EventEmitter<ThreadContext | null>();

  readonly onEntry = this.entryEmitter.event;
  readonly onReset = this.resetEmitter.event;
  readonly onPlan = this.planEmitter.event;
  readonly onUsage = this.usageEmitter.event;
  readonly onTurnActiveChanged = this.turnEmitter.event;
  readonly onContextChanged = this.contextEmitter.event;

  constructor(
    private readonly client: AppServerClient,
    private readonly logger: Logger,
  ) {}

  get threadId(): string | null {
    return this.context?.threadId ?? null;
  }

  get turnActive(): boolean {
    return this.activeTurnId !== null;
  }

  snapshot(): SessionSnapshot {
    return {
      entries: this.entryOrder
        .map((id) => this.entries.get(id))
        .filter((entry): entry is ChatEntry => entry !== undefined),
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

    // A resumed thread carries its history; replay it so the transcript matches
    // what the user saw before.
    for (const turn of response.thread.turns) {
      for (const item of turn.items) {
        const entry = mapThreadItem(item, Date.now());
        if (entry) {
          this.upsert(entry);
        }
      }
    }
    return this.adoptThread(response);
  }

  /**
   * Sends a user message. If a turn is already running the text is steered into
   * it instead of queuing a second turn, which is what the TUI does and what
   * users expect when they type mid-run.
   */
  async send(text: string, attachments: string[], settings: DitfaSettings): Promise<void> {
    const threadId = this.context?.threadId;
    if (!threadId) {
      throw new Error("No active ditfa thread.");
    }

    const input: UserInput[] = [{ type: "text", text, text_elements: [] }];
    for (const path of attachments) {
      input.push({ type: "mention", name: path, path });
    }

    if (this.activeTurnId) {
      await this.client.request("turn/steer", {
        threadId,
        expectedTurnId: this.activeTurnId,
        input,
      });
      return;
    }

    await this.client.request("turn/start", {
      threadId,
      input,
      model: settings.model || null,
      effort: settings.reasoningEffort,
      approvalPolicy: settings.approvalPolicy,
    });
  }

  async interrupt(): Promise<void> {
    const threadId = this.context?.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) {
      return;
    }
    await this.client.request("turn/interrupt", { threadId, turnId });
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
        this.plan = [];
        this.planExplanation = null;
        this.planEmitter.fire({ plan: this.plan, explanation: null });
        this.turnEmitter.fire(true);
        break;

      case "turn/completed": {
        this.activeTurnId = null;
        this.finalizeStreaming();
        this.turnEmitter.fire(false);
        const error = notification.params.turn.error;
        if (error) {
          this.pushError(error.message, error.additionalDetails, false);
        }
        break;
      }

      case "item/started":
      case "item/completed": {
        const entry = mapThreadItem(notification.params.item, Date.now());
        if (entry) {
          this.upsert(this.preserveStreamedText(entry));
        }
        break;
      }

      case "item/agentMessage/delta":
        this.appendAssistantDelta(notification.params.itemId, notification.params.delta);
        break;

      case "item/reasoning/summaryTextDelta":
        this.appendReasoningDelta(notification.params.itemId, notification.params.delta);
        break;

      case "item/reasoning/summaryPartAdded":
        this.appendReasoningDelta(notification.params.itemId, "\n\n");
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
        const used = usage.total.totalTokens;
        const window = usage.modelContextWindow;
        this.tokenUsage = {
          used,
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
        this.pushError(
          notification.params.error.message,
          notification.params.error.additionalDetails,
          notification.params.willRetry,
        );
        break;

      case "warning":
      case "configWarning":
      case "guardianWarning":
        this.pushNotice(String((notification.params as { message: string }).message), "warning");
        break;

      case "model/rerouted":
        this.pushNotice("The request was rerouted to a different model.", "info");
        break;

      default:
        break;
    }
  }

  dispose(): void {
    this.entryEmitter.dispose();
    this.resetEmitter.dispose();
    this.planEmitter.dispose();
    this.usageEmitter.dispose();
    this.turnEmitter.dispose();
    this.contextEmitter.dispose();
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
    this.context = null;
    this.resetEmitter.fire();
  }

  private upsert(entry: ChatEntry): void {
    if (!this.entries.has(entry.id)) {
      this.entryOrder.push(entry.id);
    }
    this.entries.set(entry.id, entry);
    this.entryEmitter.fire(entry);
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

  private appendAssistantDelta(itemId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "assistant") {
      this.upsert({ ...existing, text: existing.text + delta, streaming: true });
      return;
    }
    this.upsert({ id: itemId, kind: "assistant", at: Date.now(), text: delta, streaming: true });
  }

  private appendReasoningDelta(itemId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "reasoning") {
      this.upsert({ ...existing, summary: existing.summary + delta, streaming: true });
      return;
    }
    this.upsert({ id: itemId, kind: "reasoning", at: Date.now(), summary: delta, streaming: true });
  }

  private appendCommandOutput(itemId: string, delta: string): void {
    const existing = this.entries.get(itemId);
    if (existing && existing.kind === "command") {
      this.upsert({ ...existing, output: existing.output + delta });
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
      }
    }
  }

  private pushError(message: string, details: string | null, retrying: boolean): void {
    this.upsert({
      id: `error-${Date.now()}-${this.entryOrder.length}`,
      kind: "error",
      at: Date.now(),
      message,
      details,
      retrying,
    });
  }

  private pushNotice(text: string, tone: "info" | "warning"): void {
    this.upsert({
      id: `notice-${Date.now()}-${this.entryOrder.length}`,
      kind: "notice",
      at: Date.now(),
      text,
      tone,
    });
  }
}
