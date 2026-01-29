import * as vscode from "vscode";

import type { AskForApproval, ReasoningEffort, SandboxMode } from "../protocol";

export interface DitfaSettings {
  executablePath: string;
  ditfaHome: string;
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  approvalPolicy: AskForApproval;
  sandboxMode: SandboxMode;
  showReasoning: boolean;
  attachActiveFile: boolean;
  env: Record<string, string>;
}

const VALID_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];
const VALID_APPROVALS: readonly string[] = ["untrusted", "on-request", "never"];
const VALID_SANDBOXES: readonly string[] = ["read-only", "workspace-write", "danger-full-access"];

export function readSettings(scope?: vscode.Uri): DitfaSettings {
  const config = vscode.workspace.getConfiguration("ditfa", scope ?? null);

  const effort = config.get<string>("reasoningEffort", "");
  const approval = config.get<string>("approvalPolicy", "on-request");
  const sandbox = config.get<string>("sandboxMode", "workspace-write");

  return {
    executablePath: config.get<string>("executablePath", "").trim(),
    ditfaHome: config.get<string>("ditfaHome", "").trim(),
    provider: config.get<string>("provider", "").trim(),
    model: config.get<string>("model", "").trim(),
    reasoningEffort: VALID_EFFORTS.includes(effort) ? (effort as ReasoningEffort) : null,
    approvalPolicy: (VALID_APPROVALS.includes(approval)
      ? approval
      : "on-request") as AskForApproval,
    sandboxMode: (VALID_SANDBOXES.includes(sandbox) ? sandbox : "workspace-write") as SandboxMode,
    showReasoning: config.get<boolean>("showReasoning", true),
    attachActiveFile: config.get<boolean>("autoContext.activeFile", true),
    env: config.get<Record<string, string>>("env", {}) ?? {},
  };
}

export async function updateSetting<T>(
  key: string,
  value: T,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace,
): Promise<void> {
  await vscode.workspace.getConfiguration("ditfa").update(key, value, target);
}

/**
 * Working directory for a thread. Multi-root workspaces resolve against the
 * active editor so the agent operates on the folder the user is looking at.
 */
export function resolveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0]!.uri.fsPath;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) {
      return owner.uri.fsPath;
    }
  }
  return folders[0]!.uri.fsPath;
}
