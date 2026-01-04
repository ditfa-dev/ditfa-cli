import * as vscode from "vscode";

import type { ServerRequest } from "../protocol";
import type { ApprovalAnswer, ApprovalRequest, FileChangeSummary } from "../session/types";
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
        return { decision: toLegacyDecision(answer) };
      }

      default:
        this.logger.warn(`unhandled server request: ${request.method}`);
        throw new Error(`Ditfa Code does not handle ${request.method}.`);
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
    this.changeEmitter.fire([]);
  }

  dispose(): void {
    this.cancelAll();
    this.changeEmitter.dispose();
  }

  private ask(request: ApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      this.outstanding.set(request.id, { request, resolve });
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
