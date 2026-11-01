import * as vscode from "vscode";

import type { ConnectionState } from "../session/types";
import type { AccountView } from "./accountManager";

export interface StatusBarModel {
  connection: ConnectionState;
  provider: string | null;
  model: string | null;
  turnActive: boolean;
  account: AccountView;
}

/**
 * Single status-bar entry summarizing connection, model, and subscription usage.
 * Clicking it opens the account report, which is where every one of those
 * details can actually be changed.
 */
export class DitfaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "ditfa.openChat";
    this.item.name = "Ditfa Code";
    this.item.show();
  }

  update(model: StatusBarModel): void {
    this.item.text = this.buildText(model);
    this.item.tooltip = this.buildTooltip(model);
    this.item.backgroundColor =
      model.connection === "unavailable"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }

  private buildText(model: StatusBarModel): string {
    if (model.connection === "unavailable") {
      return "$(error) Ditfa";
    }
    if (model.connection !== "ready") {
      return "$(loading~spin) Ditfa";
    }

    const icon = model.turnActive ? "$(loading~spin)" : "$(sparkle)";
    const label = model.model ?? "Ditfa";
    const usage = model.account.usagePercent;
    // Only surface usage once it is high enough to matter.
    const usageSuffix = usage !== null && usage >= 50 ? ` ${Math.round(usage)}%` : "";
    return `${icon} ${label}${usageSuffix}`;
  }

  private buildTooltip(model: StatusBarModel): vscode.MarkdownString {
    const lines: string[] = ["**Ditfa Code**", ""];

    switch (model.connection) {
      case "starting":
      case "installing":
        lines.push("Starting the Ditfa engine…");
        break;
      case "missingBinary":
        lines.push("Open the Ditfa panel to finish setup.");
        break;
      case "unavailable":
        lines.push("$(error) Not connected — run `Ditfa: Run Diagnostics` for details.");
        break;
      case "ready":
        lines.push(`Provider: ${model.provider ?? "default"}`);
        lines.push(`Model: ${model.model ?? "default"}`);
        break;
    }

    if (model.account.label) {
      lines.push("", `Account: ${model.account.label}`);
      if (model.account.planLabel) {
        lines.push(`Plan: ${model.account.planLabel}`);
      }
      if (model.account.usagePercent !== null) {
        lines.push(`Usage: ${Math.round(model.account.usagePercent)}% of the current window`);
      }
    } else if (model.connection === "ready") {
      lines.push("", "Not signed in.");
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    tooltip.supportThemeIcons = true;
    return tooltip;
  }
}
