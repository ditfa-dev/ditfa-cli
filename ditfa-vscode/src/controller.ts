import * as vscode from "vscode";

import { AccountManager } from "./account/accountManager";
import { DitfaStatusBar } from "./account/statusBar";
import { ApprovalService } from "./approvals/approvalService";
import { AppServerClient } from "./client/appServerClient";
import { BinaryNotFoundError, describeMissingBinary, resolveBinary } from "./client/binary";
import { DiffService } from "./diff/diffService";
import { ProviderRegistry } from "./providers/providerRegistry";
import { ThreadSession } from "./session/threadSession";
import type {
  ChatEntry,
  ConnectionState,
  FileChangeSummary,
  SessionHeader,
  SessionState,
} from "./session/types";
import type { Logger } from "./util/logger";
import { readSettings, resolveWorkspaceRoot } from "./util/settings";

/**
 * Wires the app-server connection to everything that depends on it.
 *
 * The connection is the only thing here with a lifecycle: services are rebuilt
 * on every (re)connect, so a crashed server recovers by calling `connect()`
 * again rather than by threading reconnection logic through each service.
 */
export class DitfaController implements vscode.Disposable {
  private client: AppServerClient | undefined;
  private connectionState: ConnectionState = "starting";
  private connectionError: string | null = null;
  private connecting: Promise<void> | undefined;
  private disposed = false;

  private session: ThreadSession | undefined;
  private approvals: ApprovalService | undefined;
  private account: AccountManager | undefined;
  private providers: ProviderRegistry | undefined;

  private readonly diffs: DiffService;
  private readonly statusBar: DitfaStatusBar;
  private readonly subscriptions: vscode.Disposable[] = [];

  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly patchEmitter = new vscode.EventEmitter<Partial<SessionState>>();
  private readonly entryEmitter = new vscode.EventEmitter<ChatEntry>();

  /** Fires when the whole state should be re-pushed (connect, reset, new thread). */
  readonly onDidResetState = this.stateEmitter.event;
  /** Fires with an incremental slice for the view to apply. */
  readonly onDidPatchState = this.patchEmitter.event;
  /** Fires when a single transcript entry is added or updated. */
  readonly onDidUpsertEntry = this.entryEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.diffs = new DiffService(logger);
    this.statusBar = new DitfaStatusBar();
    this.updateStatusBar();

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("ditfa.executablePath") ||
          event.affectsConfiguration("ditfa.ditfaHome") ||
          event.affectsConfiguration("ditfa.env")
        ) {
          void this.reconnect("configuration changed");
        } else if (event.affectsConfiguration("ditfa")) {
          this.pushHeader();
        }
      }),
    );
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get accountManager(): AccountManager | undefined {
    return this.account;
  }

  get providerRegistry(): ProviderRegistry | undefined {
    return this.providers;
  }

  get approvalService(): ApprovalService | undefined {
    return this.approvals;
  }

  get diffService(): DiffService {
    return this.diffs;
  }

  get threadSession(): ThreadSession | undefined {
    return this.session;
  }

  snapshot(): SessionState {
    const session = this.session?.snapshot();
    return {
      header: this.buildHeader(),
      entries: session?.entries ?? [],
      plan: session?.plan ?? [],
      planExplanation: session?.planExplanation ?? null,
      tokenUsage: session?.tokenUsage ?? null,
      turnActive: session?.turnActive ?? false,
      approvals: this.approvals?.pending ?? [],
      showReasoning: readSettings().showReasoning,
    };
  }

  /** Connects if not already connected. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.client?.isRunning) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async reconnect(reason: string): Promise<void> {
    this.logger.info(`reconnecting: ${reason}`);
    this.teardownConnection();
    await this.connect();
  }

  async newThread(): Promise<void> {
    const session = this.session;
    if (!session) {
      await this.connect();
      return;
    }
    this.approvals?.cancelAll();
    await session.start(readSettings(), resolveWorkspaceRoot());
    this.stateEmitter.fire();
  }

  /** Lists recent threads for this workspace and resumes the chosen one. */
  async resumeThread(): Promise<void> {
    const client = this.client;
    const session = this.session;
    if (!client || !session) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }

    const cwd = resolveWorkspaceRoot();
    const response = await client.request("thread/list", {
      limit: 40,
      cwd: cwd ?? null,
      archived: false,
    });

    if (response.data.length === 0) {
      void vscode.window.showInformationMessage("No previous Ditfa threads in this workspace.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      response.data.map((thread) => ({
        threadId: thread.id,
        label: thread.name || thread.preview || "(untitled thread)",
        description: new Date(thread.updatedAt * 1000).toLocaleString(),
        detail: `${thread.modelProvider}  ·  ${thread.cwd}`,
      })),
      { title: "Ditfa: Resume Thread", placeHolder: "Pick a thread to continue", matchOnDetail: true },
    );
    if (!picked) {
      return;
    }

    this.approvals?.cancelAll();
    await session.resume(picked.threadId, readSettings(), cwd);
    this.stateEmitter.fire();
  }

  async send(text: string, attachments: string[]): Promise<void> {
    const session = this.session;
    if (!session) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }
    const settings = readSettings();

    // Echo the message immediately: app-server only emits the user item once the
    // turn starts, and a message that vanishes on send feels broken.
    this.entryEmitter.fire({
      id: `local-user-${Date.now()}`,
      kind: "user",
      at: Date.now(),
      text,
      attachments,
    });

    try {
      await session.send(text, attachments, settings);
    } catch (error) {
      this.logger.error("failed to start turn", error);
      void vscode.window.showErrorMessage(
        `Ditfa could not start the turn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.session?.interrupt();
    } catch (error) {
      this.logger.error("interrupt failed", error);
    }
  }

  /** Opens the diff for one file inside a transcript entry or a pending approval. */
  async openDiff(entryId: string, path: string): Promise<void> {
    const change = this.findChange(entryId, path);
    if (!change) {
      void vscode.window.showWarningMessage(`Ditfa has no recorded diff for ${path}.`);
      return;
    }
    const entry = this.session
      ?.snapshot()
      .entries.find((candidate) => candidate.id === entryId && candidate.kind === "fileChange");
    const applied = entry?.kind === "fileChange" && entry.status === "applied";
    await this.diffs.showChange(change, applied);
  }

  async searchFiles(query: string, limit = 12): Promise<{ label: string; path: string }[]> {
    const client = this.client;
    const cwd = resolveWorkspaceRoot();
    if (!client || !cwd) {
      return [];
    }
    try {
      const response = await client.request("fuzzyFileSearch", {
        query,
        roots: [cwd],
        cancellationToken: null,
      });
      return response.files.slice(0, limit).map((file) => ({
        label: file.file_name,
        path: file.path,
      }));
    } catch (error) {
      this.logger.debug(
        `fuzzyFileSearch failed, falling back to workspace.findFiles: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const uris = await vscode.workspace.findFiles(
        `**/*${query}*`,
        "**/{node_modules,target,dist,.git}/**",
        limit,
      );
      return uris.map((uri) => ({
        label: uri.path.split("/").pop() ?? uri.fsPath,
        path: vscode.workspace.asRelativePath(uri, false),
      }));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardownConnection();
    this.diffs.dispose();
    this.statusBar.dispose();
    this.stateEmitter.dispose();
    this.patchEmitter.dispose();
    this.entryEmitter.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async doConnect(): Promise<void> {
    this.connectionState = "starting";
    this.connectionError = null;
    this.pushHeader();
    this.updateStatusBar();

    const settings = readSettings();
    let executable: string;
    try {
      executable = resolveBinary(this.context, this.logger).path;
    } catch (error) {
      if (error instanceof BinaryNotFoundError) {
        this.failConnection("The `ditfa` executable was not found.");
        void this.offerBinaryHelp(error);
        return;
      }
      throw error;
    }

    try {
      const client = await AppServerClient.start({
        executable,
        cwd: resolveWorkspaceRoot(),
        ditfaHome: settings.ditfaHome || undefined,
        env: settings.env,
        clientVersion: this.extensionVersion(),
        logger: this.logger,
      });
      this.client = client;
      this.wireClient(client);
      await this.startServices(client);

      this.connectionState = "ready";
      this.connectionError = null;
      this.publishState();
      this.stateEmitter.fire();
      this.updateStatusBar();
    } catch (error) {
      this.logger.error("could not start the ditfa app-server", error);
      this.failConnection(error instanceof Error ? error.message : String(error));
    }
  }

  private wireClient(client: AppServerClient): void {
    client.onNotification((notification) => {
      this.session?.handleNotification(notification);
      this.account?.handleNotification(notification);
    });

    client.onExit(() => {
      if (this.disposed) {
        return;
      }
      this.approvals?.cancelAll();
      this.failConnection("The ditfa app-server stopped unexpectedly.");
    });
  }

  private async startServices(client: AppServerClient): Promise<void> {
    const session = new ThreadSession(client, this.logger);
    const approvals = new ApprovalService(this.logger, (itemId) =>
      this.lookupFileChanges(itemId),
    );
    const account = new AccountManager(client, this.logger);
    const providers = new ProviderRegistry(client, this.logger);

    client.setServerRequestHandler((request) => approvals.handle(request));

    this.session = session;
    this.approvals = approvals;
    this.account = account;
    this.providers = providers;

    this.subscriptions.push(
      session,
      approvals,
      account,
      session.onEntry((entry) => this.entryEmitter.fire(entry)),
      session.onReset(() => this.stateEmitter.fire()),
      session.onPlan(({ plan, explanation }) =>
        this.patchEmitter.fire({ plan, planExplanation: explanation }),
      ),
      session.onUsage((usage) => this.patchEmitter.fire({ tokenUsage: usage })),
      session.onTurnActiveChanged((active) => {
        this.patchEmitter.fire({ turnActive: active });
        this.updateStatusBar();
      }),
      session.onContextChanged(() => {
        this.pushHeader();
        this.updateStatusBar();
      }),
      approvals.onChange((pending) => this.patchEmitter.fire({ approvals: pending })),
      account.onChange(() => {
        this.pushHeader();
        this.updateStatusBar();
      }),
    );

    await session.start(readSettings(), resolveWorkspaceRoot());
    // Account state is a nicety; a failure here must not block the chat.
    void account.refresh();
  }

  private teardownConnection(): void {
    this.approvals?.cancelAll();
    this.client?.dispose();
    this.client = undefined;
    this.session = undefined;
    this.approvals = undefined;
    this.account = undefined;
    this.providers = undefined;
    // Service subscriptions were pushed here as a batch; drop them all so a
    // reconnect does not double-fire events into the view.
    while (this.subscriptions.length > 1) {
      this.subscriptions.pop()?.dispose();
    }
  }

  private failConnection(message: string): void {
    this.connectionState = "unavailable";
    this.connectionError = message;
    this.publishState();
    this.pushHeader();
    this.updateStatusBar();
  }

  /** Mirrors the connection state into a context key for `when` clauses. */
  private publishState(): void {
    void vscode.commands.executeCommand("setContext", "ditfa.state", this.connectionState);
  }

  private async offerBinaryHelp(error: BinaryNotFoundError): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      describeMissingBinary(error),
      { modal: true },
      "Locate binary…",
      "Show logs",
    );
    if (choice === "Locate binary…") {
      await vscode.commands.executeCommand("ditfa.locateBinary");
    } else if (choice === "Show logs") {
      this.logger.show();
    }
  }

  private lookupFileChanges(itemId: string): FileChangeSummary[] {
    const entry = this.session
      ?.snapshot()
      .entries.find((candidate) => candidate.id === itemId);
    return entry?.kind === "fileChange" ? entry.changes : [];
  }

  private findChange(entryId: string, path: string): FileChangeSummary | undefined {
    const entry = this.session?.snapshot().entries.find((candidate) => candidate.id === entryId);
    if (entry?.kind === "fileChange") {
      const match = entry.changes.find((change) => change.path === path);
      if (match) {
        return match;
      }
    }
    // Approvals are not part of the transcript yet, so look there too.
    for (const approval of this.approvals?.pending ?? []) {
      if (approval.id === entryId && approval.kind === "fileChange") {
        const match = approval.changes.find((change) => change.path === path);
        if (match) {
          return match;
        }
      }
    }
    return undefined;
  }

  private buildHeader(): SessionHeader {
    const settings = readSettings();
    const context = this.session?.snapshot().context ?? null;
    const accountView = this.account?.view();

    return {
      connection: this.connectionState,
      connectionError: this.connectionError,
      threadId: context?.threadId ?? null,
      threadName: context?.name ?? null,
      cwd: context?.cwd ?? resolveWorkspaceRoot() ?? null,
      provider: context?.provider ?? (settings.provider || null),
      model: context?.model ?? (settings.model || null),
      reasoningEffort: context?.reasoningEffort ?? settings.reasoningEffort,
      approvalPolicy: typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : "granular",
      sandboxMode: settings.sandboxMode,
      accountLabel: accountView?.label ?? null,
      planLabel: accountView?.planLabel ?? null,
      usagePercent: accountView?.usagePercent ?? null,
    };
  }

  private pushHeader(): void {
    this.patchEmitter.fire({ header: this.buildHeader() });
  }

  private updateStatusBar(): void {
    const context = this.session?.snapshot().context ?? null;
    const settings = readSettings();
    this.statusBar.update({
      connection: this.connectionState,
      provider: context?.provider ?? (settings.provider || null),
      model: context?.model ?? (settings.model || null),
      turnActive: this.session?.turnActive ?? false,
      account: this.account?.view() ?? { label: null, planLabel: null, usagePercent: null },
    });
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON as { version?: string };
    return version.version ?? "0.0.0";
  }
}
