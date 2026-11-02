import { readFile } from "node:fs/promises";
import * as vscode from "vscode";

import { planRevert } from "../checkpoints/revert";
import type { ThreadSession } from "../session/threadSession";
import type { FileChangeEntry, FileChangeSummary, HunkSkip } from "../session/types";
import type { Logger } from "../util/logger";
import { resolveUri } from "./diffService";
import { listHunks, PatchApplyError, revertHunk } from "./patch";

/**
 * Takes parts of an applied edit back out.
 *
 * The engine approves a patch as a whole, so choosing hunks happens on this side
 * of it: the change lands, and what the user did not want is removed again,
 * through the editor so it can be undone with Ctrl+Z like any other edit. Every
 * hunk is found by its content, which keeps working after the file has moved.
 */
export class HunkReview {
  constructor(
    private readonly session: () => ThreadSession | undefined,
    private readonly cwd: () => string | undefined,
    private readonly logger: Logger,
  ) {}

  /** Undoes the given hunks of one file in an applied edit. */
  async revertHunks(entryId: string, path: string, hunks: number[], reason = "undid"): Promise<void> {
    const session = this.session();
    const found = this.find(entryId, path);
    if (!session || !found || found.change.kind !== "update") {
      return;
    }
    const { change } = found;
    const all = listHunks(change.diff);
    const already = new Set(change.reverted ?? []);
    const pending = [...new Set(hunks)].filter((index) => index >= 0 && index < all.length && !already.has(index));
    if (pending.length === 0) {
      return;
    }

    const uri = resolveUri(change.movePath ?? change.path, this.cwd());
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`Ditfa could not open ${change.label} to undo that change.`);
      return;
    }

    // Right after the engine writes a file, the editor may still hold the old text.
    await untilEditorMatchesDisk(document);
    let text = document.getText().replace(/\r\n/g, "\n");
    const done: number[] = [];
    const failed: number[] = [];
    for (const index of pending) {
      try {
        text = revertHunk(text, all[index]!);
        done.push(index);
      } catch (error) {
        if (!(error instanceof PatchApplyError)) {
          throw error;
        }
        this.logger.debug(`hunk ${index} of ${change.path} stays: ${error.message}`);
        failed.push(index);
      }
    }

    if (done.length > 0) {
      await writeThroughEditor(document, text);
      const where = done
        .map((index) => {
          const hunk = all[index]!;
          return `lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines, 1) - 1}`;
        })
        .join(", ");
      session.markReverted(
        entryId,
        change.path,
        done,
        false,
        `I ${reason} part of your edit to ${change.path} (${where}); it is back to how it was. Do not apply it again unless I ask.`,
      );
    }
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `${failed.length === 1 ? "One change" : `${failed.length} changes`} in ${change.label} could not be undone: that part of the file was edited since.`,
      );
    }
  }

  /** Undoes everything an applied edit did to one file. */
  async undoFile(entryId: string, path: string): Promise<void> {
    const session = this.session();
    const found = this.find(entryId, path);
    const cwd = this.cwd();
    if (!session || !found || !cwd) {
      return;
    }
    const { change } = found;

    if (change.kind === "update") {
      await this.revertHunks(
        entryId,
        path,
        listHunks(change.diff).map((_, index) => index),
      );
      return;
    }
    if (change.undone) {
      return;
    }

    const plan = await planRevert([change], cwd, readText);
    const step = plan.steps[0];
    if (!step) {
      void vscode.window.showWarningMessage(
        `${change.label} was not changed: ${plan.skipped[0]?.reason ?? "it is already as it was"}.`,
      );
      return;
    }
    const uri = vscode.Uri.file(step.path);
    if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === step.path)) {
      void vscode.window.showWarningMessage(`${change.label} has unsaved edits, so it was left alone.`);
      return;
    }
    if (step.content === null) {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(step.content, "utf8"));
    }
    session.markReverted(
      entryId,
      change.path,
      [],
      true,
      change.kind === "add"
        ? `I deleted ${change.path}, which you created. Do not create it again unless I ask.`
        : `I brought back ${change.path}, which you deleted. Do not delete it again unless I ask.`,
    );
  }

  /** Removes the hunks the user left unticked when they approved an edit. */
  async applySkips(entry: FileChangeEntry, skips: HunkSkip[]): Promise<void> {
    for (const skip of skips) {
      await this.revertHunks(entry.id, skip.path, skip.hunks, "chose not to keep");
    }
  }

  private find(entryId: string, path: string): { entry: FileChangeEntry; change: FileChangeSummary } | undefined {
    const entry = this.session()
      ?.snapshot()
      .entries.find((candidate) => candidate.id === entryId);
    if (entry?.kind !== "fileChange" || entry.status !== "applied") {
      return undefined;
    }
    const change = entry.changes.find((candidate) => candidate.path === path);
    return change ? { entry, change } : undefined;
  }
}

/**
 * Replaces only the span of the document that differs, so the cursor, folds and
 * undo stack of the rest of the file are untouched, and saves when the buffer was
 * clean before: the agent's own edit was on disk, and this one should be too.
 */
async function writeThroughEditor(document: vscode.TextDocument, text: string): Promise<void> {
  const wasDirty = document.isDirty;
  const current = document.getText();
  const target = document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, "\r\n") : text;

  let prefix = 0;
  const shortest = Math.min(current.length, target.length);
  while (prefix < shortest && current[prefix] === target[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(prefix), document.positionAt(current.length - suffix)),
    target.slice(prefix, target.length - suffix),
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("The editor refused the change.");
  }
  if (!wasDirty) {
    await document.save();
  }
}

/**
 * Waits, briefly, for a clean editor buffer to catch up with the file on disk.
 * Editing a stale buffer and saving it would overwrite what the engine just wrote.
 */
async function untilEditorMatchesDisk(document: vscode.TextDocument): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (document.isDirty) {
      return;
    }
    const onDisk = await readText(document.uri.fsPath);
    if (onDisk === null || onDisk === document.getText()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
