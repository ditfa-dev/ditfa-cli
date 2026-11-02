import * as vscode from "vscode";

import type { Logger } from "../util/logger";
import { updateSetting } from "../util/settings";
import { CompletionError, requestCompletion } from "./client";
import {
  allowsMultiline,
  cleanCompletion,
  isSensitivePath,
  takeWindow,
  worthSuggesting,
  type CompletionRequest,
} from "./prompt";
import type { TargetResult } from "./target";

/** What the service needs from the rest of the extension. */
export interface CompletionHost {
  resolveTarget(): Promise<TargetResult>;
  /** Walks the user through provider, key and model, then turns completions on. */
  setup(): Promise<void>;
}

interface CompletionSettings {
  enabled: boolean;
  debounceMs: number;
  maxTokens: number;
  multiline: boolean;
  contextFiles: boolean;
  disabledLanguages: string[];
}

const ASKED_KEY = "ditfa.completion.asked";
const BEFORE_CURSOR = 6_000;
const AFTER_CURSOR = 2_000;
const MAX_LINES = 14;
const NEIGHBOR_CHARS = 1_200;
const MAX_NEIGHBORS = 2;
const CACHE_SIZE = 40;
/** Consecutive failures before suggestions pause, and for how long. */
const FAILURE_LIMIT = 3;
const PAUSE_MS = 60_000;
const MAX_LINES_IN_FILE = 30_000;

function readSettings(): CompletionSettings {
  const config = vscode.workspace.getConfiguration("ditfa");
  return {
    enabled: config.get<boolean>("completion.enabled", false),
    debounceMs: Math.max(0, config.get<number>("completion.debounceMs", 300)),
    maxTokens: Math.min(1024, Math.max(16, config.get<number>("completion.maxTokens", 128))),
    multiline: config.get<boolean>("completion.multiline", true),
    contextFiles: config.get<boolean>("completion.contextFiles", true),
    disabledLanguages: config.get<string[]>("completion.disabledLanguages", []),
  };
}

/**
 * Tab autocomplete: grey text at the cursor that Tab accepts.
 *
 * It is off until the user turns it on, because it sends the code around the
 * cursor to a provider on every pause in typing, and that deserves a clear yes.
 */
export class CompletionService implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly cache = new Map<string, string>();
  private readonly recent: string[] = [];
  private inFlight = 0;
  private failures = 0;
  private pausedUntil = 0;
  private lastError: string | null = null;
  private asking = false;
  private readonly warned = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: CompletionHost,
    private readonly logger: Logger,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.status.name = "Ditfa Tab autocomplete";
    this.status.command = "ditfa.completion.toggle";
    this.status.show();
    this.render();

    this.subscriptions.push(
      this.status,
      vscode.languages.registerInlineCompletionItemProvider(
        [{ scheme: "file" }, { scheme: "untitled" }],
        this,
      ),
      vscode.commands.registerCommand("ditfa.completion.toggle", () => this.toggle()),
      vscode.commands.registerCommand("ditfa.completion.setup", () => this.host.setup()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ditfa.completion")) {
          this.cache.clear();
          this.failures = 0;
          this.pausedUntil = 0;
          this.lastError = null;
          this.render();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const key = editor?.document.uri.toString();
        if (key) {
          const at = this.recent.indexOf(key);
          if (at !== -1) {
            this.recent.splice(at, 1);
          }
          this.recent.unshift(key);
          this.recent.length = Math.min(this.recent.length, 6);
        }
      }),
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.cache.clear();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = readSettings();
    if (!usable(document, settings)) {
      return undefined;
    }

    const line = document.lineAt(position.line).text;
    const linePrefix = line.slice(0, position.character);
    const restOfLine = line.slice(position.character);
    const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    const previousLine = position.line > 0 ? document.lineAt(position.line - 1).text : "";
    if (automatic && !worthSuggesting(linePrefix, previousLine)) {
      return undefined;
    }

    if (!settings.enabled) {
      void this.offerOptIn();
      return undefined;
    }
    // Do not fight the suggest widget for the same keystroke, or run while paused after errors.
    if (context.selectedCompletionInfo || Date.now() < this.pausedUntil) {
      return undefined;
    }

    if (automatic && settings.debounceMs > 0 && !(await pause(settings.debounceMs, token))) {
      return undefined;
    }

    const text = document.getText();
    const window = takeWindow(text, document.offsetAt(position), BEFORE_CURSOR, AFTER_CURSOR);
    const cacheKey = `${document.uri.toString()}|${window.prefix.slice(-500)}|${window.suffix.slice(0, 200)}`;
    const multiline = settings.multiline && allowsMultiline(restOfLine);
    const clean = (raw: string) =>
      cleanCompletion(raw, { prefix: window.prefix, suffix: window.suffix, multiline, maxLines: MAX_LINES });

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached ? [item(cached, position)] : undefined;
    }

    const resolved = await this.host.resolveTarget();
    if (!resolved.ok) {
      this.explain(resolved.reason, resolved.message);
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }

    const request: CompletionRequest = {
      prefix: window.prefix,
      suffix: window.suffix,
      language: document.languageId,
      path: vscode.workspace.asRelativePath(document.uri, false),
      neighbors: settings.contextFiles ? this.neighbors(document) : [],
    };

    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    this.setBusy(1);
    try {
      const raw = await requestCompletion(resolved.target, request, {
        maxTokens: settings.maxTokens,
        signal: abort.signal,
      });
      this.failures = 0;
      this.lastError = null;
      const text = clean(raw);
      this.remember(cacheKey, text ?? "");
      return text ? [item(text, position)] : undefined;
    } catch (error) {
      if (abort.signal.aborted || token.isCancellationRequested) {
        return undefined;
      }
      this.fail(error);
      return undefined;
    } finally {
      cancel.dispose();
      this.setBusy(-1);
    }
  }

  private async toggle(): Promise<void> {
    const settings = readSettings();
    if (settings.enabled) {
      await updateSetting("completion.enabled", false);
      return;
    }
    const resolved = await this.host.resolveTarget();
    if (resolved.ok) {
      await updateSetting("completion.enabled", true);
    } else {
      await this.host.setup();
    }
  }

  /** Asks once, in plain words, before any code leaves the editor for suggestions. */
  private async offerOptIn(): Promise<void> {
    if (this.asking || this.context.globalState.get<boolean>(ASKED_KEY)) {
      return;
    }
    this.asking = true;
    try {
      await this.context.globalState.update(ASKED_KEY, true);
      const choice = await vscode.window.showInformationMessage(
        "Ditfa can suggest code as you type, and Tab accepts it. It sends the code around your cursor to the provider you choose.",
        "Set up Tab autocomplete",
        "Not now",
      );
      if (choice === "Set up Tab autocomplete") {
        await this.host.setup();
      }
    } finally {
      this.asking = false;
    }
  }

  private remember(key: string, value: string): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  /** Other open files the suggestion may need, never anything that looks like a secret. */
  private neighbors(current: vscode.TextDocument): { path: string; text: string }[] {
    const seen = new Set([current.uri.toString()]);
    const candidates: vscode.TextDocument[] = [];
    for (const key of [...vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()), ...this.recent]) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === key);
      if (document && usable(document, readSettings())) {
        candidates.push(document);
      }
    }
    candidates.sort(
      (a, b) => Number(b.languageId === current.languageId) - Number(a.languageId === current.languageId),
    );
    return candidates.slice(0, MAX_NEIGHBORS).map((document) => ({
      path: vscode.workspace.asRelativePath(document.uri, false),
      text: document.getText().slice(0, NEIGHBOR_CHARS),
    }));
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`tab completion failed: ${message}`);
    this.failures += 1;
    this.lastError = message;
    if (this.failures >= FAILURE_LIMIT) {
      this.pausedUntil = Date.now() + PAUSE_MS;
      this.failures = 0;
    }
    if (error instanceof CompletionError && (error.kind === "auth" || error.kind === "model")) {
      this.explain(error.kind, message);
    }
    this.render();
  }

  /** Tells the user what is missing, once per kind, with the button that fixes it. */
  private explain(kind: string, message: string): void {
    this.lastError = message;
    this.render();
    if (this.warned.has(kind)) {
      return;
    }
    this.warned.add(kind);
    void vscode.window
      .showWarningMessage(`Tab autocomplete: ${message}`, "Set up Tab autocomplete")
      .then((choice) => (choice ? this.host.setup() : undefined));
  }

  private setBusy(delta: number): void {
    this.inFlight = Math.max(0, this.inFlight + delta);
    this.render();
  }

  private render(): void {
    const enabled = readSettings().enabled;
    this.status.backgroundColor = undefined;
    if (!enabled) {
      this.status.text = "$(circle-slash) Tab";
      this.status.tooltip = "Ditfa Tab autocomplete is off. Click to set it up.";
      return;
    }
    if (this.lastError) {
      this.status.text = "$(warning) Tab";
      this.status.tooltip = `Ditfa Tab autocomplete: ${this.lastError}\nClick to turn it off.`;
      this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    this.status.text = this.inFlight > 0 ? "$(loading~spin) Tab" : "$(sparkle) Tab";
    this.status.tooltip = "Ditfa Tab autocomplete is on. Click to turn it off.";
  }
}

function item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
  return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
}

function usable(document: vscode.TextDocument, settings: CompletionSettings): boolean {
  return (
    document.lineCount <= MAX_LINES_IN_FILE &&
    !settings.disabledLanguages.includes(document.languageId) &&
    !isSensitivePath(document.uri.fsPath)
  );
}

/** Resolves false when the request was cancelled while waiting, so stale work never starts. */
function pause(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve(false);
      return;
    }
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(false);
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(true);
    }, ms);
  });
}
