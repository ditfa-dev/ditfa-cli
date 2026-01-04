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
 * the extension never handles the credential beyond passing an API key the user
 * explicitly typed straight to the local server.
 */
export class AccountManager implements vscode.Disposable {
  private state: AccountState = { account: null, requiresAuth: false, rateLimits: null };
  private readonly emitter = new vscode.EventEmitter<AccountState>();
  private activeLoginId: string | null = null;

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
      case "account/login/completed": {
        const { success, error } = notification.params;
        this.activeLoginId = null;
        if (success) {
          void vscode.window.showInformationMessage("Signed in to Ditfa.");
          void this.refresh();
        } else {
          void vscode.window.showErrorMessage(`Ditfa sign-in failed: ${error ?? "unknown error"}`);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Runs the sign-in flow the user picks. Resolves once the flow has been started. */
  async signIn(): Promise<void> {
    const method = await vscode.window.showQuickPick(
      [
        {
          id: "chatgpt" as const,
          label: "$(globe) Sign in with a Ditfa subscription",
          detail: "Opens your browser to authorize this machine",
        },
        {
          id: "deviceCode" as const,
          label: "$(device-mobile) Sign in with a device code",
          detail: "For remote or headless machines with no browser",
        },
        {
          id: "apiKey" as const,
          label: "$(key) Use an API key",
          detail: "Pay-as-you-go with your own provider key",
        },
      ],
      { title: "Ditfa: Sign In", placeHolder: "How do you want to authenticate?" },
    );
    if (!method) {
      return;
    }

    switch (method.id) {
      case "chatgpt":
        await this.startBrowserLogin();
        break;
      case "deviceCode":
        await this.startDeviceCodeLogin();
        break;
      case "apiKey":
        await this.startApiKeyLogin();
        break;
    }
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

  async cancelLogin(): Promise<void> {
    const loginId = this.activeLoginId;
    if (!loginId) {
      return;
    }
    this.activeLoginId = null;
    await this.client.request("account/login/cancel", { loginId });
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

  private async startBrowserLogin(): Promise<void> {
    const response = await this.client.request("account/login/start", {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    });
    if (response.type !== "chatgpt") {
      return;
    }
    this.activeLoginId = response.loginId;

    const opened = await vscode.env.openExternal(vscode.Uri.parse(response.authUrl));
    if (!opened) {
      void vscode.window.showWarningMessage(
        `Open this URL to finish signing in: ${response.authUrl}`,
      );
    }

    void vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Waiting for Ditfa sign-in…", cancellable: true },
        (_progress, token) =>
          new Promise<void>((resolve) => {
            token.onCancellationRequested(() => {
              void this.cancelLogin();
              resolve();
            });
            // `account/login/completed` clears activeLoginId; poll for that.
            const timer = setInterval(() => {
              if (this.activeLoginId !== response.loginId) {
                clearInterval(timer);
                resolve();
              }
            }, 500);
          }),
      )
      .then(undefined, () => undefined);
  }

  private async startDeviceCodeLogin(): Promise<void> {
    const response = await this.client.request("account/login/start", { type: "chatgptDeviceCode" });
    if (response.type !== "chatgptDeviceCode") {
      return;
    }
    this.activeLoginId = response.loginId;

    const action = await vscode.window.showInformationMessage(
      `Go to ${response.verificationUrl} and enter code ${response.userCode}`,
      "Copy code",
      "Open page",
    );
    if (action === "Copy code") {
      await vscode.env.clipboard.writeText(response.userCode);
    } else if (action === "Open page") {
      await vscode.env.openExternal(vscode.Uri.parse(response.verificationUrl));
    }
  }

  private async startApiKeyLogin(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "Ditfa: API Key",
      prompt: "The key is sent to the local ditfa server and stored in your ditfa home directory",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Enter an API key" : undefined),
    });
    if (!apiKey) {
      return;
    }
    await this.client.request("account/login/start", { type: "apiKey", apiKey: apiKey.trim() });
    await this.refresh();
    void vscode.window.showInformationMessage("API key saved.");
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
