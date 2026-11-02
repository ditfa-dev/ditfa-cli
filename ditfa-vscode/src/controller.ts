import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

import { AccountManager } from "./account/accountManager";
import { ApiKeys } from "./account/apiKeys";
import { DitfaStatusBar } from "./account/statusBar";
import { ApprovalService } from "./approvals/approvalService";
import { planRevert } from "./checkpoints/revert";
import { AppServerClient } from "./client/appServerClient";
import {
  BinaryNotFoundError,
  managedBinaryDirectory,
  resolveBinary,
  type ResolvedBinary,
} from "./client/binary";
import { buildDoctorReport } from "./client/doctor";
import { installEngine } from "./client/installer";
import { DiffService } from "./diff/diffService";
import { CompletionSetup } from "./completion/setup";
import { HunkReview } from "./diff/hunkReview";
import {
  BUILT_IN_PROVIDERS,
  PROVIDER_ENV_KEYS,
  probeLocal,
  ProviderRegistry,
  type ProviderInfo,
} from "./providers/providerRegistry";
import { buildUserInput, type ActiveFileContext } from "./session/promptContext";
import { ThreadSession, type TurnOptions } from "./session/threadSession";
import { TranscriptStore } from "./session/transcriptStore";
import type {
  ActiveEditorInfo,
  AgentMode,
  ChatEntry,
  ConnectionState,
  ContextAttachment,
  ErrorAction,
  FileChangeSummary,
  FileSuggestion,
  InstallProgress,
  ModelCatalog,
  SessionHeader,
  SessionState,
  SetupOption,
  SlashCommand,
  ThreadSummary,
} from "./session/types";
import type { Logger } from "./util/logger";
import {
  modeFromSettings,
  readSettings,
  resolveWorkspaceRoot,
  sandboxPolicyFor,
  settingsForMode,
  updateSetting,
  workspaceRoots,
} from "./util/settings";

const LAST_THREAD_KEY = "ditfa.lastThreadId";
/** Crashes allowed inside the window before giving up and showing the error. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120_000;
/** How long a turn gets to honor Stop before the engine is restarted under it. */
const STOP_DEADLINE_MS = 6_000;

const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "new", label: "new", detail: "Start a new conversation", kind: "builtin" },
  { id: "review", label: "review", detail: "Review uncommitted changes", kind: "builtin" },
  { id: "compact", label: "compact", detail: "Summarize the conversation to free up context", kind: "builtin" },
  { id: "undo", label: "undo", detail: "Undo the last turn's file changes", kind: "builtin" },
  { id: "doctor", label: "doctor", detail: "Run diagnostics", kind: "builtin" },
];

/**
 * Wires the app-server connection to everything that depends on it.
 *
 * The connection is the only thing here with a lifecycle: services are rebuilt
 * on every (re)connect, so a crashed server recovers by calling `connect()`
 * again rather than by threading reconnection logic through each service.
 * Nothing starts until the panel is opened or a command needs it; an editor
 * window the user never asks anything in costs no engine process.
 */
export class DitfaController implements vscode.Disposable {
  private client: AppServerClient | undefined;
  private binary: ResolvedBinary | null = null;
  private binaryAttempts: string[] = [];
  private connectionState: ConnectionState = "starting";
  private connectionError: string | null = null;
  private connecting: Promise<void> | undefined;
  private install: InstallProgress | null = null;
  private disposed = false;

  private session: ThreadSession | undefined;
  private approvals: ApprovalService | undefined;
  private account: AccountManager | undefined;
  private providers: ProviderRegistry | undefined;

  private configuredProvider: string | null = null;
  private configuredModel: string | null = null;
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private budgetTripped = false;
  /** Set when a key for the selected provider is stored or the provider needs none. */
  private providerReady = false;

  private readonly keys: ApiKeys;
  private readonly store: TranscriptStore;
  private readonly diffs: DiffService;
  private readonly hunkReview: HunkReview;
  /** Tab autocomplete's way into this controller's keys and providers. */
  readonly completion: CompletionSetup;
  private readonly statusBar: DitfaStatusBar;
  private readonly subscriptions: vscode.Disposable[] = [];
  private serviceSubscriptions: vscode.Disposable[] = [];

  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly patchEmitter = new vscode.EventEmitter<Partial<SessionState>>();
  private readonly entryEmitter = new vscode.EventEmitter<ChatEntry>();
  private readonly removeEmitter = new vscode.EventEmitter<string>();
  private readonly composerEmitter = new vscode.EventEmitter<string>();
  private readonly editorEmitter = new vscode.EventEmitter<ActiveEditorInfo | null>();

  /** Fires when the whole state should be re-pushed (connect, reset, new thread). */
  readonly onDidResetState = this.stateEmitter.event;
  /** Fires with an incremental slice for the view to apply. */
  readonly onDidPatchState = this.patchEmitter.event;
  /** Fires when a single transcript entry is added or updated. */
  readonly onDidUpsertEntry = this.entryEmitter.event;
  readonly onDidRemoveEntry = this.removeEmitter.event;
  /** Fires with text the composer should hold, such as a message that was rewound. */
  readonly onDidSetComposer = this.composerEmitter.event;
  readonly onDidChangeActiveEditor = this.editorEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.keys = new ApiKeys(context.secrets);
    this.store = new TranscriptStore(join(context.globalStorageUri.fsPath, "transcripts"), logger);
    this.diffs = new DiffService(logger);
    this.hunkReview = new HunkReview(
      () => this.session,
      () => this.threadCwd(),
      logger,
    );
    this.completion = new CompletionSetup({
      keys: this.keys,
      providers: async () =>
        this.providers ? this.providers.listProviders(resolveWorkspaceRoot()) : BUILT_IN_PROVIDERS,
      chatProvider: () => this.effectiveProviderId(),
      chatModel: () => readSettings().model || this.session?.snapshot().context?.model || this.configuredModel || "",
    });
    this.statusBar = new DitfaStatusBar();
    this.updateStatusBar();

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("ditfa.executablePath") ||
          event.affectsConfiguration("ditfa.ditfaHome") ||
          event.affectsConfiguration("ditfa.env")
        ) {
          if (this.client) {
            void this.reconnect("configuration changed");
          }
        } else if (event.affectsConfiguration("ditfa")) {
          void this.refreshProviderReady();
          this.pushHeader();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.editorEmitter.fire(this.activeEditor())),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.editorEmitter.fire(this.activeEditor());
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.pushHeader()),
    );
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get accountManager(): AccountManager | undefined {
    return this.account;
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

  /** The engine to launch from a terminal, when one has been found. */
  get executable(): string | undefined {
    return this.binary?.path;
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
    if (this.disposed || this.client?.isRunning) {
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
    this.crashTimes = [];
    await this.connecting?.catch(() => undefined);
    this.teardownConnection();
    await this.connect();
  }

  async newThread(): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session) {
      return;
    }
    if (session.turnActive) {
      await this.interrupt();
    }
    this.approvals?.cancelAll();
    // The thread is created by the first message, so an unused one leaves no trace.
    session.clear();
    await this.rememberThread(null);
    this.stateEmitter.fire();
  }

  async listThreads(query: string): Promise<ThreadSummary[]> {
    await this.connect();
    const client = this.client;
    if (!client) {
      return [];
    }
    const roots = workspaceRoots();
    const response = await client.request("thread/list", {
      limit: 50,
      cwd: roots.length > 0 ? roots : null,
      archived: false,
      sortKey: "updated_at",
      searchTerm: query.trim() || null,
    });
    const active = this.session?.threadId;
    return response.data.map((thread) => ({
      id: thread.id,
      title: thread.name || thread.preview || "Untitled conversation",
      updatedAt: thread.updatedAt * 1000,
      provider: thread.modelProvider,
      active: thread.id === active,
    }));
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session || session.threadId === threadId) {
      return;
    }
    if (session.turnActive) {
      await this.interrupt();
    }
    this.approvals?.cancelAll();
    await session.resume(threadId, readSettings(), resolveWorkspaceRoot());
    await this.rememberThread(threadId);
    this.stateEmitter.fire();
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await this.client?.request("thread/name/set", { threadId, name: title });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.client?.request("thread/delete", { threadId });
    await this.store.remove(threadId);
    if (this.session?.threadId === threadId) {
      await this.newThread();
    }
  }

  async send(
    text: string,
    attachments: ContextAttachment[],
    skill: { name: string; path: string } | null = null,
    includeActiveFile = true,
  ): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session) {
      void vscode.window.showWarningMessage("The Ditfa engine is not running yet.");
      return;
    }

    try {
      if (!session.threadId) {
        await session.start(this.effectiveSettings(), resolveWorkspaceRoot());
        await this.rememberThread(session.threadId);
      }
      this.budgetTripped = false;
      const active = includeActiveFile && readSettings().attachActiveFile ? this.activeFileContext() : null;
      const input = buildUserInput(text, attachments, active, skill, session.takeNotes());
      const labels = attachments.map((item) => item.label);
      await session.send({ text, attachments: labels }, input, this.turnOptions());
    } catch (error) {
      this.logger.error("failed to start turn", error);
      void vscode.window.showErrorMessage(
        `Ditfa could not start the turn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Stop means stop: a turn that does not end promptly loses its engine. */
  async interrupt(): Promise<void> {
    const session = this.session;
    if (!session?.turnActive) {
      return;
    }
    try {
      await session.interrupt();
    } catch (error) {
      this.logger.error("interrupt failed", error);
    }
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.session === session && session.turnActive) {
        this.logger.warn("turn ignored the interrupt; restarting the engine");
        void this.restartKeepingThread("The turn did not stop, so the engine was restarted.");
      }
    }, STOP_DEADLINE_MS);
  }

  async review(): Promise<void> {
    await this.ensureThread();
    await this.session?.review();
  }

  async compact(): Promise<void> {
    await this.session?.compact();
  }

  async runSlashCommand(id: string): Promise<void> {
    switch (id) {
      case "new":
        await this.newThread();
        break;
      case "review":
        await this.review();
        break;
      case "compact":
        await this.compact();
        break;
      case "undo": {
        const turnId = this.session?.latestTurnId;
        if (turnId) {
          await this.restoreCheckpoint(turnId);
        }
        break;
      }
      case "doctor":
        await this.runDoctor();
        break;
    }
  }

  async runErrorAction(action: ErrorAction): Promise<void> {
    switch (action) {
      case "signIn":
        await this.setupProvider(this.effectiveProviderId() ?? "ditfa");
        break;
      case "retry":
        await this.session?.resend(this.turnOptions());
        break;
      case "compact":
        await this.compact();
        break;
      case "selectModel":
        await vscode.commands.executeCommand("ditfa.selectProvider");
        break;
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
    await this.diffs.showChange(change, applied, this.threadCwd());
  }

  /**
   * The agent believes the whole patch landed. When the user left hunks out mid-turn,
   * say so now, as a steer, instead of letting it build on lines that are gone.
   */
  private async tellAgentWhatWasLeftOut(session: ThreadSession): Promise<void> {
    if (!session.turnActive) {
      return;
    }
    const notes = session.takeNotes();
    if (notes.length === 0) {
      return;
    }
    const text = notes.join("\n");
    try {
      await session.send({ text, attachments: [] }, [{ type: "text", text, text_elements: [] }], this.turnOptions());
    } catch (error) {
      this.logger.warn(`could not tell the agent about the hunks left out: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Takes chosen hunks of an applied edit back out. */
  async revertHunks(entryId: string, path: string, hunks: number[]): Promise<void> {
    await this.hunkReview.revertHunks(entryId, path, hunks);
  }

  async undoFile(entryId: string, path: string): Promise<void> {
    await this.hunkReview.undoFile(entryId, path);
  }

  async reviewTurn(turnId: string): Promise<void> {
    const changes = this.session?.changesIn(turnId) ?? [];
    if (changes.length > 0) {
      await this.diffs.showAll("Ditfa: changes in this turn", changes, this.threadCwd());
    }
  }

  /**
   * Rewinds to just before `turnId`: reverts the files the agent changed since,
   * drops those turns from the conversation, and puts the message back in the
   * composer so it can be edited and sent again.
   */
  async restoreCheckpoint(turnId: string): Promise<void> {
    const session = this.session;
    const cwd = this.threadCwd();
    if (!session || !cwd) {
      return;
    }
    if (session.turnActive) {
      void vscode.window.showWarningMessage("Stop the current turn first.");
      return;
    }

    const changes = session.changesSince(turnId);
    const plan = await planRevert(changes, cwd, readText);

    // A file with unsaved edits would be silently overwritten on disk.
    const dirty = new Set(
      vscode.workspace.textDocuments.filter((doc) => doc.isDirty).map((doc) => doc.uri.fsPath),
    );
    const steps = plan.steps.filter((step) => !dirty.has(step.path));
    const skipped = [
      ...plan.skipped,
      ...plan.steps
        .filter((step) => dirty.has(step.path))
        .map((step) => ({ path: step.path, reason: "it has unsaved edits" })),
    ];

    const fileLine =
      steps.length === 0
        ? "No files need reverting."
        : `${steps.length} file${steps.length === 1 ? "" : "s"} will be reverted.`;
    const skippedLine =
      skipped.length > 0
        ? `\n\nLeft alone:\n${skipped.map((item) => `• ${vscode.workspace.asRelativePath(item.path)}: ${item.reason}`).join("\n")}`
        : "";
    const confirmed = await vscode.window.showWarningMessage(
      "Go back to before this message?",
      {
        modal: true,
        detail: `${fileLine} The conversation rewinds to this point.\n\nEffects of commands the agent ran, such as installed packages, are not undone.${skippedLine}`,
      },
      "Restore",
    );
    if (confirmed !== "Restore") {
      return;
    }

    for (const step of steps) {
      const uri = vscode.Uri.file(step.path);
      if (step.content === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(step.content, "utf8"));
      }
    }

    const original = session.userEntryFor(turnId);
    try {
      await session.rollbackTo(turnId);
      if (original) {
        this.composerEmitter.fire(original.text);
      }
    } catch (error) {
      this.logger.error("rollback failed", error);
      session.notice("Files were restored, but the conversation could not be rewound.", "warning");
    }
  }

  async searchFiles(query: string, limit = 12): Promise<FileSuggestion[]> {
    const client = this.client;
    const roots = workspaceRoots();
    if (roots.length === 0) {
      return [];
    }

    // An empty query means "what am I working on": offer the open tabs.
    if (query.length === 0) {
      return vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))
        .filter((uri) => uri.scheme === "file")
        .slice(0, limit)
        .map((uri) => ({
          label: uri.path.split("/").pop() ?? uri.fsPath,
          path: vscode.workspace.asRelativePath(uri, false),
          kind: "file" as const,
        }));
    }

    try {
      if (!client) {
        throw new Error("not connected");
      }
      const response = await client.request("fuzzyFileSearch", {
        query,
        roots,
        cancellationToken: null,
      });
      return response.files.slice(0, limit).map((file) => ({
        label: file.file_name,
        path: roots.length === 1 ? file.path : join(file.root, file.path),
        kind: "file" as const,
      }));
    } catch (error) {
      this.logger.debug(
        `fuzzyFileSearch failed, falling back to workspace.findFiles: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const uris = await vscode.workspace.findFiles(
        `**/*${query.replace(/[*?[\]{}]/g, "")}*`,
        "**/{node_modules,target,dist,.git}/**",
        limit,
      );
      return uris.map((uri) => ({
        label: uri.path.split("/").pop() ?? uri.fsPath,
        path: vscode.workspace.asRelativePath(uri, false),
        kind: "file" as const,
      }));
    }
  }

  activeEditor(): ActiveEditorInfo | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return null;
    }
    const selection = editor.selection;
    return {
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      label: editor.document.uri.path.split("/").pop() ?? editor.document.fileName,
      selection: selection.isEmpty
        ? null
        : { start: selection.start.line + 1, end: selection.end.line + 1 },
    };
  }

  /** Commands and skills for the `/` menu. Skills are the user's own, so they go first. */
  async slashCommands(): Promise<SlashCommand[]> {
    if (!this.client) {
      return BUILTIN_COMMANDS;
    }
    try {
      const roots = workspaceRoots();
      const response = await this.client.request("skills/list", { cwds: roots });
      const skills = response.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled)
        .map(
          (skill): SlashCommand => ({
            id: `skill:${skill.name}`,
            label: skill.name,
            detail: skill.shortDescription ?? skill.description,
            kind: "skill",
            path: skill.path,
          }),
        );
      return [...BUILTIN_COMMANDS, ...skills];
    } catch (error) {
      this.logger.debug(`skills/list failed: ${error instanceof Error ? error.message : error}`);
      return BUILTIN_COMMANDS;
    }
  }

  async setupOptions(): Promise<SetupOption[]> {
    const options: SetupOption[] = [];
    for (const provider of BUILT_IN_PROVIDERS) {
      const ready =
        provider.kind === "local" && provider.baseUrl
          ? await probeLocal(provider.baseUrl)
          : provider.envKey
            ? await this.keys.has(provider.envKey)
            : false;
      options.push({
        id: provider.id,
        label: provider.id === "ditfa" ? "Sign in with Ditfa" : provider.name,
        detail:
          provider.kind === "local"
            ? ready
              ? "Running on this machine"
              : "Not running"
            : provider.kind === "account"
              ? "Your Ditfa plan, every model, nothing to configure"
              : "Use your own API key",
        kind: provider.kind,
        ready,
      });
    }
    return options;
  }

  /** Makes `id` the active provider, collecting whatever it needs first. */
  async setupProvider(id: string): Promise<void> {
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === id);
    if (!provider) {
      return;
    }

    if (provider.kind === "account") {
      await this.setupDitfaAccount(provider);
      return;
    }

    if (provider.kind === "apiKey") {
      const apiKey = await vscode.window.showInputBox({
        title: `${provider.name} API key`,
        prompt: provider.keyUrl
          ? `Stored in your system keychain. Create one at ${provider.keyUrl}`
          : "Stored in your system keychain",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? "Enter an API key" : undefined),
      });
      if (!apiKey) {
        return;
      }
      if (provider.envKey) {
        await this.keys.set(provider.envKey, apiKey.trim());
      } else {
        await this.account?.saveOpenAiKey(apiKey.trim());
      }
    }

    await this.activateProvider(provider);
  }

  private async setupDitfaAccount(provider: ProviderInfo): Promise<void> {
    const method = await vscode.window.showQuickPick(
      [
        {
          id: "login" as const,
          label: "$(globe) Sign in with your browser",
          detail: "Confirm a one-time code on chat.ditfa.com",
        },
        {
          id: "key" as const,
          label: "$(key) Paste a Ditfa API key",
          detail: "Create one at chat.ditfa.com/api-keys",
        },
      ],
      { title: "Sign in to Ditfa" },
    );
    if (method?.id === "login" && this.binary) {
      await this.account?.signIn(this.binary.path, () => void this.activateProvider(provider));
    } else if (method?.id === "key" && provider.envKey) {
      const apiKey = await vscode.window.showInputBox({
        title: "Ditfa API key",
        prompt: "Stored in your system keychain",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? "Enter an API key" : undefined),
      });
      if (apiKey) {
        await this.keys.set(provider.envKey, apiKey.trim());
        await this.activateProvider(provider);
      }
    }
  }

  /** Switches to `provider` and restarts so the engine sees any new key. */
  private async activateProvider(provider: ProviderInfo): Promise<void> {
    await updateSetting("provider", provider.id);
    await updateSetting("model", "");
    await this.reconnect(`provider set to ${provider.id}`);
    await this.newThread();
  }

  async providerChoices(): Promise<ProviderInfo[]> {
    await this.connect();
    return (await this.providers?.listProviders(resolveWorkspaceRoot())) ?? BUILT_IN_PROVIDERS;
  }

  async modelCatalog(): Promise<ModelCatalog> {
    await this.connect();
    const providers = await this.providerChoices();
    const id = this.effectiveProviderId();
    const provider = providers.find((candidate) => candidate.id === id) ?? null;
    const base = { provider: id, providerLabel: provider?.name ?? null };
    if (!this.providers) {
      return { ...base, models: [], error: "The Ditfa engine is not running." };
    }
    try {
      const apiKey = provider?.envKey ? await this.keys.get(provider.envKey) : undefined;
      const models = await this.providers.listModels(provider, apiKey);
      return { ...base, models, error: null };
    } catch (error) {
      return { ...base, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A model change applies to the next message; the conversation carries on. */
  async selectModel(model: string, effort: string | null): Promise<void> {
    await updateSetting("model", model);
    await updateSetting("reasoningEffort", effort ?? "");
    this.pushHeader();
  }

  /** A provider is fixed for the life of a thread, so changing it starts a new one. */
  async selectProvider(id: string): Promise<void> {
    const provider = (await this.providerChoices()).find((candidate) => candidate.id === id);
    if (!provider) {
      return;
    }
    const needsKey = provider.envKey !== null && !(await this.keys.has(provider.envKey));
    if (needsKey || provider.kind === "account") {
      await this.setupProvider(id);
      return;
    }
    await updateSetting("provider", id);
    await updateSetting("model", "");
    this.providers?.invalidate();
    if (this.session?.threadId) {
      await this.newThread();
    }
    await this.refreshProviderReady();
    this.pushHeader();
  }

  async setMode(mode: AgentMode): Promise<void> {
    if (mode === "full") {
      const confirmed = await vscode.window.showWarningMessage(
        "Full access removes the sandbox. The agent can run any command and change any file this account can reach, without asking.",
        { modal: true },
        "Enable full access",
      );
      if (confirmed !== "Enable full access") {
        this.pushHeader();
        return;
      }
    }
    const next = settingsForMode(mode);
    await updateSetting("approvalPolicy", next.approvalPolicy);
    await updateSetting("sandboxMode", next.sandboxMode);
    this.pushHeader();
  }

  /** Installs the engine, then connects. Driven by a button, never by surprise. */
  async installEngine(): Promise<void> {
    if (this.connectionState === "installing") {
      return;
    }
    this.connectionState = "installing";
    this.connectionError = null;
    this.setInstallProgress({ stage: "download", percent: 0 });
    try {
      await this.connecting?.catch(() => undefined);
      this.teardownConnection();
      await installEngine(
        managedBinaryDirectory(this.context),
        (progress) => this.setInstallProgress(progress),
        this.logger,
      );
      this.install = null;
      this.connectionState = "starting";
      await this.connect();
    } catch (error) {
      this.logger.error("engine install failed", error);
      this.install = null;
      this.failConnection(error instanceof Error ? error.message : String(error));
    }
  }

  async runDoctor(): Promise<void> {
    const settings = readSettings();
    const stored: string[] = [];
    for (const envKey of PROVIDER_ENV_KEYS) {
      if (await this.keys.has(envKey)) {
        stored.push(envKey);
      }
    }
    const content = await buildDoctorReport({
      extensionVersion: this.extensionVersion(),
      binary: this.binary,
      binaryAttempts: this.binaryAttempts,
      connection: this.connectionState,
      connectionError: this.connectionError,
      engineVersion: this.client?.version ?? null,
      provider: this.effectiveProviderId(),
      model: settings.model || this.session?.snapshot().context?.model || this.configuredModel,
      storedKeys: stored,
    });
    const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stopTimer);
    this.teardownConnection();
    this.diffs.dispose();
    this.statusBar.dispose();
    this.stateEmitter.dispose();
    this.patchEmitter.dispose();
    this.entryEmitter.dispose();
    this.removeEmitter.dispose();
    this.composerEmitter.dispose();
    this.editorEmitter.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async ensureThread(): Promise<void> {
    await this.connect();
    const session = this.session;
    if (session && !session.threadId) {
      await session.start(this.effectiveSettings(), resolveWorkspaceRoot());
      await this.rememberThread(session.threadId);
    }
  }

  private async doConnect(): Promise<void> {
    this.connectionState = "starting";
    this.connectionError = null;
    this.pushHeader();
    this.updateStatusBar();

    const settings = readSettings();
    try {
      this.binary = resolveBinary(this.context, this.logger);
      this.binaryAttempts = [];
    } catch (error) {
      if (error instanceof BinaryNotFoundError) {
        this.binary = null;
        this.binaryAttempts = error.attempts;
        this.connectionState = "missingBinary";
        this.publishState();
        this.pushHeader();
        this.updateStatusBar();
        return;
      }
      throw error;
    }

    try {
      const client = await AppServerClient.start({
        executable: this.binary.path,
        cwd: resolveWorkspaceRoot(),
        ditfaHome: settings.ditfaHome || undefined,
        env: { ...(await this.keys.environment(PROVIDER_ENV_KEYS)), ...settings.env },
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
      if (notification.method === "serverRequest/resolved") {
        this.approvals?.serverResolved(notification.params.requestId);
      }
    });

    client.onExit(() => {
      if (!this.disposed && client === this.client) {
        this.handleCrash(client.lastError());
      }
    });
  }

  private async startServices(client: AppServerClient): Promise<void> {
    const session = new ThreadSession(client, this.logger, this.store);
    const approvals = new ApprovalService(this.logger, (itemId) => this.lookupFileChanges(itemId));
    const account = new AccountManager(client, this.logger);
    const providers = new ProviderRegistry(client, this.logger);

    client.setServerRequestHandler((request) => approvals.handle(request));

    this.session = session;
    this.approvals = approvals;
    this.account = account;
    this.providers = providers;

    this.serviceSubscriptions.push(
      session,
      approvals,
      account,
      session.onEntry((entry) => this.entryEmitter.fire(entry)),
      session.onRemoveEntry((id) => this.removeEmitter.fire(id)),
      session.onReset(() => this.stateEmitter.fire()),
      session.onPlan(({ plan, explanation }) =>
        this.patchEmitter.fire({ plan, planExplanation: explanation }),
      ),
      session.onUsage((usage) => {
        this.patchEmitter.fire({ tokenUsage: usage });
        this.enforceBudget(session);
      }),
      session.onTurnActiveChanged((active) => {
        this.patchEmitter.fire({ turnActive: active });
        this.updateStatusBar();
        if (!active) {
          clearTimeout(this.stopTimer);
          this.approvals?.cancelAll();
          void account.refreshRateLimits();
        }
      }),
      session.onContextChanged(() => {
        this.pushHeader();
        this.updateStatusBar();
      }),
      session.onFileChangeApplied((entry) => {
        const skips = approvals.takeSkips(entry.id);
        if (skips) {
          void this.hunkReview.applySkips(entry, skips).then(() => this.tellAgentWhatWasLeftOut(session));
        }
      }),
      session.onLoopDetected((command) => {
        session.notice(`Stopped: the agent ran \`${command}\` six times in a row without progress.`, "warning");
        void this.interrupt();
      }),
      approvals.onChange((pending) => this.patchEmitter.fire({ approvals: pending })),
      account.onChange(() => {
        void this.refreshProviderReady();
        this.pushHeader();
        this.updateStatusBar();
      }),
    );

    const defaults = await providers.configuredDefaults(resolveWorkspaceRoot());
    this.configuredProvider = defaults.provider;
    this.configuredModel = defaults.model;

    await this.restoreLastThread(session);
    // Account state is a nicety; a failure here must not block the chat.
    await account.refresh();
    await this.refreshProviderReady();
  }

  /** Brings back the conversation that was open, so a reload loses nothing. */
  private async restoreLastThread(session: ThreadSession): Promise<void> {
    const threadId = this.context.workspaceState.get<string>(LAST_THREAD_KEY);
    if (!threadId) {
      return;
    }
    try {
      await session.resume(threadId, this.effectiveSettings(), resolveWorkspaceRoot());
    } catch (error) {
      this.logger.info(`could not resume ${threadId}: ${error instanceof Error ? error.message : error}`);
      session.clear();
      await this.rememberThread(null);
    }
  }

  private async rememberThread(threadId: string | null): Promise<void> {
    await this.context.workspaceState.update(LAST_THREAD_KEY, threadId ?? undefined);
  }

  /** The engine died. Bring it back and resume, unless it keeps dying. */
  private handleCrash(detail: string): void {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    this.crashTimes.push(now);
    this.teardownConnection();

    if (this.crashTimes.length > MAX_RESTARTS) {
      this.failConnection(detail || "The Ditfa engine keeps stopping unexpectedly.");
      return;
    }

    const delay = 1000 * 2 ** (this.crashTimes.length - 1);
    this.logger.warn(`engine stopped; restarting in ${delay}ms`);
    this.connectionState = "starting";
    this.pushHeader();
    this.updateStatusBar();
    this.restartTimer = setTimeout(() => {
      void this.connect().then(() => {
        this.session?.notice("The Ditfa engine restarted. Your conversation is intact.", "warning");
      });
    }, delay);
  }

  private async restartKeepingThread(message: string): Promise<void> {
    await this.reconnect(message);
    this.session?.notice(message, "warning");
  }

  private enforceBudget(session: ThreadSession): void {
    const limit = readSettings().maxTokensPerTurn;
    if (limit > 0 && !this.budgetTripped && session.turnActive && session.turnTokens > limit) {
      this.budgetTripped = true;
      session.notice(
        `Stopped: this turn used more than the ${limit.toLocaleString()} token limit set in ditfa.maxTokensPerTurn.`,
        "warning",
      );
      void this.interrupt();
    }
  }

  private teardownConnection(): void {
    clearTimeout(this.stopTimer);
    this.approvals?.cancelAll();
    this.client?.dispose();
    this.client = undefined;
    for (const subscription of this.serviceSubscriptions) {
      subscription.dispose();
    }
    this.serviceSubscriptions = [];
    this.session = undefined;
    this.approvals = undefined;
    this.account = undefined;
    this.providers = undefined;
  }

  private failConnection(message: string): void {
    this.connectionState = "unavailable";
    this.connectionError = message;
    this.publishState();
    this.pushHeader();
    this.updateStatusBar();
  }

  private setInstallProgress(progress: InstallProgress): void {
    this.install = progress;
    this.pushHeader();
  }

  /** Mirrors the connection state into a context key for `when` clauses. */
  private publishState(): void {
    void vscode.commands.executeCommand("setContext", "ditfa.state", this.connectionState);
  }

  /** Settings with the mode a window with no folder is limited to. */
  private effectiveSettings() {
    const settings = readSettings();
    if (settings.provider || !this.configuredProvider) {
      return this.applyFolderLimit(settings);
    }
    return this.applyFolderLimit({ ...settings, provider: this.configuredProvider });
  }

  /** Without a folder there is no workspace to sandbox writes into, so nothing is writable. */
  private applyFolderLimit<T extends ReturnType<typeof readSettings>>(settings: T): T {
    return workspaceRoots().length > 0 ? settings : { ...settings, ...settingsForMode("plan") };
  }

  private turnOptions(): TurnOptions {
    const settings = this.effectiveSettings();
    return {
      settings,
      sandboxPolicy: sandboxPolicyFor(settings.sandboxMode, workspaceRoots(), settings.allowNetwork),
    };
  }

  private activeFileContext(): ActiveFileContext | null {
    const info = this.activeEditor();
    const editor = vscode.window.activeTextEditor;
    return info && editor ? { path: info.path, line: editor.selection.active.line + 1 } : null;
  }

  private threadCwd(): string | undefined {
    return this.session?.snapshot().context?.cwd ?? resolveWorkspaceRoot();
  }

  private effectiveProviderId(): string | null {
    return (
      readSettings().provider ||
      this.session?.snapshot().context?.provider ||
      this.configuredProvider ||
      null
    );
  }

  private async refreshProviderReady(): Promise<void> {
    const id = this.effectiveProviderId();
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === id);
    const signedIn = Boolean(this.account?.current.account);
    let ready = signedIn;
    if (!provider) {
      // A custom provider from config.toml: the user has already set it up.
      ready = Boolean(id) || signedIn;
    } else if (provider.kind === "local") {
      ready = true;
    } else if (provider.envKey) {
      ready =
        signedIn ||
        (await this.keys.has(provider.envKey)) ||
        Boolean(process.env[provider.envKey]) ||
        Boolean(readSettings().env[provider.envKey]);
    }
    if (ready !== this.providerReady) {
      this.providerReady = ready;
    }
    this.pushHeader();
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
    const provider = this.effectiveProviderId();
    const open = workspaceRoots().length > 0;

    return {
      connection: this.connectionState,
      connectionError: this.connectionError,
      install: this.install,
      threadId: context?.threadId ?? null,
      threadName: context?.name ?? null,
      cwd: context?.cwd ?? resolveWorkspaceRoot() ?? null,
      workspaceOpen: open,
      provider,
      providerLabel: BUILT_IN_PROVIDERS.find((item) => item.id === provider)?.name ?? provider,
      // The setting wins: it is what the next turn will actually use.
      model: settings.model || context?.model || this.configuredModel,
      reasoningEffort: settings.reasoningEffort ?? context?.reasoningEffort ?? null,
      mode: open ? modeFromSettings(settings) : "plan",
      accountLabel: accountView?.label ?? null,
      planLabel: accountView?.planLabel ?? null,
      usagePercent: accountView?.usagePercent ?? null,
      needsSetup: this.connectionState === "ready" && !this.providerReady,
    };
  }

  private pushHeader(): void {
    if (!this.disposed) {
      this.patchEmitter.fire({ header: this.buildHeader() });
    }
  }

  private updateStatusBar(): void {
    const context = this.session?.snapshot().context ?? null;
    const settings = readSettings();
    this.statusBar.update({
      connection: this.connectionState,
      provider: this.effectiveProviderId(),
      model: settings.model || context?.model || this.configuredModel,
      turnActive: this.session?.turnActive ?? false,
      account: this.account?.view() ?? { label: null, planLabel: null, usagePercent: null },
    });
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON as { version?: string };
    return version.version ?? "0.0.0";
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
