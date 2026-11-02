import * as vscode from "vscode";

import type { RequestId, ServerRequest } from "../protocol";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  FileChangeSummary,
  HunkSkip,
} from "../session/types";
import type { Logger } from "../util/logger";

interface Outstanding {
  request: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
}

/**
 * Bridges server-initiated approval requests to the chat UI.
 *
 * app-server blocks the agent until each request gets a response, so every path
 * out of here must settle: a dismissed panel or a torn-down session resolves as
 * a cancel rather than leaving the agent hanging.
 */
export class ApprovalService implements vscode.Disposable {
  private readonly outstanding = new Map<string, Outstanding>();
  private readonly changeEmitter = new vscode.EventEmitter<ApprovalRequest[]>();
  private counter = 0;
  /** The JSON-RPC request behind the approval being asked right now. */
  private currentRequestId: RequestId | null = null;
  private readonly byRequestId = new Map<RequestId, Set<string>>();
  /**
   * Hunks the user left out of an approved edit. The engine can only take a whole
   * patch, so these come back out once it has landed.
   */
  private readonly skips = new Map<string, HunkSkip[]>();

  readonly onChange = this.changeEmitter.event;

  constructor(
    private readonly logger: Logger,
    /** Resolves the file changes attached to a `fileChange` item already in the transcript. */
    private readonly lookupFileChanges: (itemId: string) => FileChangeSummary[],
  ) {}

  get pending(): ApprovalRequest[] {
    return [...this.outstanding.values()].map((entry) => entry.request);
  }

  /** Handles a server request, returning the JSON-RPC result payload. */
  async handle(request: ServerRequest): Promise<unknown> {
    this.currentRequestId = request.id;
    try {
      return await this.dispatch(request);
    } finally {
      this.byRequestId.delete(request.id);
    }
  }

  /**
   * The server settled a request on its own: the turn was interrupted, or an
   * automatic review answered it. Its card must not sit there asking.
   */
  serverResolved(requestId: RequestId): void {
    for (const id of this.byRequestId.get(requestId) ?? []) {
      const entry = this.outstanding.get(id);
      if (entry) {
        this.outstanding.delete(id);
        entry.resolve(cancelAnswer(id, entry.request.kind));
      }
    }
    this.byRequestId.delete(requestId);
    this.changeEmitter.fire(this.pending);
  }

  private async dispatch(request: ServerRequest): Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const params = request.params;
        const answer = await this.ask({
          kind: "command",
          id: this.nextId(),
          command: params.command ?? "(command unavailable)",
          cwd: params.cwd ?? null,
          reason: params.reason ?? null,
          canAlwaysAllow: true,
        });
        return {
          decision: answer.kind === "command" ? answer.decision : "cancel",
        };
      }

      case "item/fileChange/requestApproval": {
        const params = request.params;
        const answer = await this.ask({
          kind: "fileChange",
          id: this.nextId(),
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
          changes: this.lookupFileChanges(params.itemId),
        });
        this.rememberSkips(params.itemId, answer);
        return {
          decision: answer.kind === "fileChange" ? answer.decision : "cancel",
        };
      }

      case "item/permissions/requestApproval": {
        const params = request.params;
        const answer = await this.ask({
          kind: "permissions",
          id: this.nextId(),
          reason: params.reason,
          cwd: params.cwd,
          summary: summarizePermissions(params.permissions),
        });
        const granted = answer.kind === "permissions" && answer.decision === "accept";
        return {
          permissions: granted ? params.permissions : {},
          scope: granted ? "turn" : "denied",
        };
      }

      case "item/tool/requestUserInput": {
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of request.params.questions) {
          const answer = await this.ask({
            kind: "userInput",
            id: this.nextId(),
            question: question.question || question.header,
            options: (question.options ?? []).map((option) => ({
              label: option.label,
              value: option.label,
            })),
            allowFreeform: question.isOther || (question.options ?? []).length === 0,
          });
          answers[question.id] = {
            answers: answer.kind === "userInput" && answer.value ? [answer.value] : [],
          };
        }
        return { answers };
      }

      case "mcpServer/elicitation/request": {
        const params = request.params;
        const answer = await this.ask({
          kind: "elicitation",
          id: this.nextId(),
          server: params.serverName,
          message: params.message,
          url: params.mode === "url" ? params.url : null,
        });
        const accepted = answer.kind === "elicitation" && answer.decision === "accept";
        return { action: accepted ? "accept" : "decline", content: accepted ? {} : null, _meta: null };
      }

      // Legacy approval methods, kept so older ditfa builds still work.
      case "execCommandApproval": {
        const params = request.params as { command?: string[] | string; cwd?: string };
        const command = Array.isArray(params.command)
          ? params.command.join(" ")
          : (params.command ?? "(command unavailable)");
        const answer = await this.ask({
          kind: "command",
          id: this.nextId(),
          command,
          cwd: params.cwd ?? null,
          reason: null,
          canAlwaysAllow: true,
        });
        return { decision: toLegacyDecision(answer) };
      }

      case "applyPatchApproval": {
        const answer = await this.ask({
          kind: "fileChange",
          id: this.nextId(),
          reason: request.params.reason ?? null,
          grantRoot: request.params.grantRoot ?? null,
          changes: this.lookupFileChanges(request.params.callId),
        });
        this.rememberSkips(request.params.callId, answer);
        return { decision: toLegacyDecision(answer) };
      }

      default:
        this.logger.warn(`unhandled server request: ${request.method}`);
        throw new Error(`Ditfa does not handle ${request.method}.`);
    }
  }

  /** What to take back out of the change `itemId` once it has been applied, if anything. */
  takeSkips(itemId: string): HunkSkip[] | undefined {
    const skips = this.skips.get(itemId);
    this.skips.delete(itemId);
    return skips;
  }

  private rememberSkips(itemId: string, answer: ApprovalAnswer): void {
    if (
      answer.kind === "fileChange" &&
      (answer.decision === "accept" || answer.decision === "acceptForSession") &&
      answer.skip &&
      answer.skip.length > 0
    ) {
      this.skips.set(itemId, answer.skip);
    }
  }

  /** Called when the webview reports the user's choice. */
  resolve(answer: ApprovalAnswer): void {
    const entry = this.outstanding.get(answer.id);
    if (!entry) {
      this.logger.warn(`approval answer for unknown request ${answer.id}`);
      return;
    }
    this.outstanding.delete(answer.id);
    entry.resolve(answer);
    this.changeEmitter.fire(this.pending);
  }

  /** Cancels everything outstanding — used when the session or panel goes away. */
  cancelAll(): void {
    for (const [id, entry] of this.outstanding) {
      entry.resolve(cancelAnswer(id, entry.request.kind));
    }
    this.outstanding.clear();
    this.skips.clear();
    this.changeEmitter.fire([]);
  }

  dispose(): void {
    this.cancelAll();
    this.changeEmitter.dispose();
  }

  private ask(request: ApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      this.outstanding.set(request.id, { request, resolve });
      if (this.currentRequestId !== null) {
        const ids = this.byRequestId.get(this.currentRequestId) ?? new Set<string>();
        ids.add(request.id);
        this.byRequestId.set(this.currentRequestId, ids);
      }
      this.changeEmitter.fire(this.pending);
    });
  }

  private nextId(): string {
    return `approval-${++this.counter}`;
  }
}

function cancelAnswer(id: string, kind: ApprovalRequest["kind"]): ApprovalAnswer {
  switch (kind) {
    case "command":
      return { id, kind: "command", decision: "cancel" };
    case "fileChange":
      return { id, kind: "fileChange", decision: "cancel" };
    case "permissions":
      return { id, kind: "permissions", decision: "decline" };
    case "userInput":
      return { id, kind: "userInput", value: "" };
    case "elicitation":
      return { id, kind: "elicitation", decision: "decline" };
  }
}

function toLegacyDecision(answer: ApprovalAnswer): string {
  if (answer.kind === "command" || answer.kind === "fileChange") {
    switch (answer.decision) {
      case "accept":
        return "approved";
      case "acceptForSession":
        return "approved_for_session";
      case "decline":
        return "denied";
      default:
        return "abort";
    }
  }
  return "abort";
}

function summarizePermissions(permissions: unknown): string {
  if (!permissions || typeof permissions !== "object") {
    return "additional permissions";
  }
  const parts: string[] = [];
  const record = permissions as Record<string, unknown>;
  if (record.fileSystem) {
    parts.push("filesystem access");
  }
  if (record.network) {
    parts.push("network access");
  }
  return parts.length > 0 ? parts.join(" and ") : "additional permissions";
}
