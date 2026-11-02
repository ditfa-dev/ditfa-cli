import * as vscode from "vscode";

import type { AppServerClient } from "../client/appServerClient";
import type { Account, RateLimitSnapshot, ServerNotification } from "../protocol";
import type { Logger } from "../util/logger";

export interface AccountState {
  account: Account | null;
  /** True when the configured provider needs a ditfa/OpenAI sign-in to work. */
  requiresAuth: boolean;
  rateLimits: RateLimitSnapshot | null;
}

export interface AccountView {
  label: string | null;
  planLabel: string | null;
  /** Primary rate-limit window usage, 0-100. */
  usagePercent: number | null;
}

/**
 * Owns ditfa account state: who is signed in, on what plan, and how much of the
 * subscription's rate-limit window is left.
 *
 * Sign-in itself always happens in the user's browser or in a VS Code input box —
 * the extension never holds a password, only keys the user explicitly typed.
 */
export class AccountManager implements vscode.Disposable {
  private state: AccountState = { account: null, requiresAuth: false, rateLimits: null };
  private readonly emitter = new vscode.EventEmitter<AccountState>();

  readonly onChange = this.emitter.event;

  constructor(
    private readonly client: AppServerClient,
    private readonly logger: Logger,
  ) {}

  get current(): AccountState {
    return this.state;
  }

  view(): AccountView {
    const { account, rateLimits } = this.state;
    return {
      label: describeAccount(account),
      planLabel: account?.type === "chatgpt" ? formatPlan(account.planType) : null,
      usagePercent: rateLimits?.primary?.usedPercent ?? null,
    };
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.client.request("account/read", { refreshToken: false });
      this.state = {
        ...this.state,
        account: response.account,
        requiresAuth: response.requiresOpenaiAuth,
      };
      this.emitter.fire(this.state);
    } catch (error) {
      this.logger.debug(`account/read failed: ${error instanceof Error ? error.message : error}`);
    }

    await this.refreshRateLimits();
  }

  async refreshRateLimits(): Promise<void> {
    if (!this.state.account) {
      return;
    }
    try {
      const response = await this.client.request("account/rateLimits/read", undefined);
      this.state = { ...this.state, rateLimits: response.rateLimits };
      this.emitter.fire(this.state);
    } catch (error) {
      this.logger.debug(
        `account/rateLimits/read failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "account/updated":
        void this.refresh();
        break;
      case "account/rateLimits/updated":
        // Rolling updates are sparse: merge rather than replace so fields the
        // update omits keep their last known value.
        this.state = {
          ...this.state,
          rateLimits: { ...this.state.rateLimits, ...notification.params.rateLimits },
        };
        this.emitter.fire(this.state);
        break;
      default:
        break;
    }
  }

  /**
   * Signs in to a Ditfa account. `ditfa login` is the flow that mints the
   * account's API key; the server's own login methods cover other backends.
   * It runs in a terminal because it shows a code the user has to confirm.
   */
  async signIn(executable: string, onFinished: () => void): Promise<void> {
    const terminal = vscode.window.createTerminal({
      name: "Ditfa sign-in",
      shellPath: executable,
      shellArgs: ["login"],
      iconPath: new vscode.ThemeIcon("sign-in"),
    });
    terminal.show();

    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        listener.dispose();
        if (closed.exitStatus?.code === 0) {
          onFinished();
        }
      }
    });
  }

  async signOut(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Sign out of Ditfa on this machine?",
      { modal: true },
      "Sign out",
    );
    if (confirmed !== "Sign out") {
      return;
    }
    await this.client.request("account/logout", undefined);
    this.state = { account: null, requiresAuth: this.state.requiresAuth, rateLimits: null };
    this.emitter.fire(this.state);
    void vscode.window.showInformationMessage("Signed out of Ditfa.");
  }

  /** Renders account, plan, and usage as a readable report. */
  async describeUsage(): Promise<string> {
    await this.refresh();
    const { account, rateLimits } = this.state;
    const lines: string[] = [];

    lines.push(`Account: ${describeAccount(account) ?? "not signed in"}`);
    if (account?.type === "chatgpt") {
      lines.push(`Plan: ${formatPlan(account.planType)}`);
    }

    if (rateLimits?.primary) {
      lines.push(
        `Primary limit: ${rateLimits.primary.usedPercent.toFixed(0)}% used${formatReset(rateLimits.primary.resetsAt)}`,
      );
    }
    if (rateLimits?.secondary) {
      lines.push(
        `Secondary limit: ${rateLimits.secondary.usedPercent.toFixed(0)}% used${formatReset(rateLimits.secondary.resetsAt)}`,
      );
    }
    if (rateLimits?.credits) {
      lines.push(
        rateLimits.credits.unlimited
          ? "Credits: unlimited"
          : `Credits: ${rateLimits.credits.balance ?? "unknown"}`,
      );
    }

    try {
      const usage = await this.client.request("account/usage/read", undefined);
      const lifetime = usage.summary.lifetimeTokens;
      if (lifetime !== null) {
        lines.push(`Lifetime tokens: ${Number(lifetime).toLocaleString()}`);
      }
      const streak = usage.summary.currentStreakDays;
      if (streak !== null) {
        lines.push(`Current streak: ${Number(streak)} days`);
      }
    } catch {
      // Usage stats are a nicety; a provider without them should not break the report.
    }

    return lines.join("\n");
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** OpenAI keys go through the server, which stores them in the ditfa home. */
  async saveOpenAiKey(apiKey: string): Promise<void> {
    await this.client.request("account/login/start", { type: "apiKey", apiKey });
    await this.refresh();
  }
}

function describeAccount(account: Account | null): string | null {
  if (!account) {
    return null;
  }
  switch (account.type) {
    case "chatgpt":
      return account.email ?? "Ditfa subscription";
    case "apiKey":
      return "API key";
    case "amazonBedrock":
      return "Amazon Bedrock";
  }
}

function formatPlan(plan: string): string {
  return plan
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatReset(resetsAt: number | null): string {
  if (!resetsAt) {
    return "";
  }
  const when = new Date(resetsAt * 1000);
  return ` (resets ${when.toLocaleString()})`;
}
