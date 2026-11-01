import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";

import type { FileChangeSummary } from "../session/types";
import type { Logger } from "../util/logger";
import { applyUnifiedDiff, PatchApplyError, revertUnifiedDiff } from "./patch";

const SCHEME = "ditfa-diff";

/**
 * Opens agent file changes in VS Code's native diff editor.
 *
 * app-server sends unified diffs, so one side of the comparison has to be
 * reconstructed from the file on disk. Which side depends on whether the patch
 * has landed yet: for a pending change the working copy is the "before", and
 * for an applied change it is the "after". When reconstruction fails — the file
 * moved, the patch no longer applies — the raw patch is shown instead, which is
 * always truthful even if less pleasant.
 */
export class DiffService implements vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  private counter = 0;

  constructor(private readonly logger: Logger) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: this.changeEmitter.event,
      provideTextDocumentContent: (uri) => this.documents.get(uri.path) ?? "",
    });
  }

  dispose(): void {
    this.registration.dispose();
    this.changeEmitter.dispose();
    this.documents.clear();
  }

  async showChange(change: FileChangeSummary, applied: boolean, cwd?: string): Promise<void> {
    const fileUri = resolveUri(change.path, cwd);

    if (change.kind === "add") {
      // Adds and deletes carry the whole file in `diff`, not a unified diff.
      const content = applied ? await this.readFile(fileUri) : change.diff;
      await this.openDiff(
        this.virtualUri(`${change.label} (new)`, ""),
        this.virtualUri(change.label, content ?? ""),
        `${change.label} — added`,
      );
      return;
    }

    if (change.kind === "delete") {
      const content = applied ? change.diff : await this.readFile(fileUri);
      await this.openDiff(
        this.virtualUri(change.label, content ?? ""),
        this.virtualUri(`${change.label} (deleted)`, ""),
        `${change.label} — deleted`,
      );
      return;
    }

    const onDisk = await this.readFile(fileUri);
    if (onDisk === undefined) {
      await this.showRawPatch(change, "the file could not be read");
      return;
    }

    try {
      const before = applied ? revertUnifiedDiff(onDisk, change.diff) : onDisk;
      const after = applied ? onDisk : applyUnifiedDiff(onDisk, change.diff);
      const left = this.virtualUri(`${change.label} (before)`, before);
      // The right side points at the real file once the patch has landed so the
      // diff stays editable and live.
      const right = applied ? fileUri : this.virtualUri(`${change.label} (after)`, after);
      await this.openDiff(left, right, `${change.label} — ditfa changes`);
    } catch (error) {
      if (error instanceof PatchApplyError) {
        this.logger.debug(`falling back to raw patch for ${change.path}: ${error.message}`);
        await this.showRawPatch(change, error.message);
        return;
      }
      throw error;
    }
  }

  /** Opens every file a turn touched as one scrolling review. */
  async showAll(title: string, changes: FileChangeSummary[], cwd?: string): Promise<void> {
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    for (const change of changes) {
      const fileUri = resolveUri(change.path, cwd);
      const onDisk = (await this.readFile(fileUri)) ?? "";
      let before = "";
      if (change.kind === "delete") {
        before = change.diff;
      } else if (change.kind === "update") {
        try {
          before = revertUnifiedDiff(onDisk, change.diff);
        } catch {
          before = onDisk;
        }
      }
      resources.push([fileUri, this.virtualUri(`${change.label} (before)`, before), fileUri]);
    }
    try {
      await vscode.commands.executeCommand("vscode.changes", title, resources);
    } catch (error) {
      // Older hosts and some forks lack the multi-file editor.
      this.logger.debug(`vscode.changes unavailable: ${error instanceof Error ? error.message : error}`);
      const first = changes[0];
      if (first) {
        await this.showChange(first, true, cwd);
      }
    }
  }

  /** Shows the unified diff itself, syntax-highlighted, when a real diff is not possible. */
  async showRawPatch(change: FileChangeSummary, reason: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      content: `# ${change.path}\n# rendered as a patch: ${reason}\n\n${change.diff}`,
      language: "diff",
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async openDiff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand("vscode.diff", left, right, title, {
      preview: true,
    });
  }

  private virtualUri(label: string, content: string): vscode.Uri {
    const key = `/${this.counter++}/${label}`;
    this.documents.set(key, content);
    const uri = vscode.Uri.from({ scheme: SCHEME, path: key });
    this.changeEmitter.fire(uri);
    return uri;
  }

  private async readFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

function resolveUri(path: string, cwd?: string): vscode.Uri {
  return vscode.Uri.file(cwd && !isAbsolute(path) ? join(cwd, path) : path);
}
