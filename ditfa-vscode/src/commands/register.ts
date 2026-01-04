import * as vscode from "vscode";

import type { DitfaController } from "../controller";
import { pickApprovalMode, pickModel, pickProvider } from "../providers/modelPicker";
import type { ChatViewProvider } from "../ui/chatViewProvider";
import type { Logger } from "../util/logger";
import { readSettings, resolveWorkspaceRoot, updateSetting } from "../util/settings";

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: DitfaController,
  view: ChatViewProvider,
  logger: Logger,
): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          logger.error(`command ${id} failed`, error);
          void vscode.window.showErrorMessage(
            `Ditfa: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  };

  register("ditfa.openChat", () => {
    view.reveal();
  });

  register("ditfa.newThread", async () => {
    view.reveal();
    await controller.newThread();
  });

  register("ditfa.resumeThread", async () => {
    view.reveal();
    await controller.resumeThread();
  });

  register("ditfa.interrupt", () => controller.interrupt());

  register("ditfa.selectModel", async () => {
    const registry = controller.providerRegistry;
    if (!registry) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }
    const cwd = resolveWorkspaceRoot();
    // Provider first: the model list only makes sense once the provider is known.
    if (!(await pickProvider(registry, cwd))) {
      return;
    }
    if (await pickModel(registry)) {
      await offerRestartForNewSettings(controller);
    }
  });

  register("ditfa.selectProvider", async () => {
    const registry = controller.providerRegistry;
    if (!registry) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }
    if (await pickProvider(registry, resolveWorkspaceRoot())) {
      await offerRestartForNewSettings(controller);
    }
  });

  register("ditfa.selectApprovalMode", async () => {
    if (await pickApprovalMode()) {
      await offerRestartForNewSettings(controller);
    }
  });

  register("ditfa.signIn", async () => {
    const account = controller.accountManager;
    if (!account) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }
    await account.signIn();
  });

  register("ditfa.signOut", async () => {
    await controller.accountManager?.signOut();
  });

  register("ditfa.showAccount", async () => {
    const account = controller.accountManager;
    if (!account) {
      void vscode.window.showWarningMessage("Ditfa is not connected yet.");
      return;
    }
    const report = await account.describeUsage();
    const choice = await vscode.window.showInformationMessage(
      report,
      { modal: true },
      account.current.account ? "Sign out" : "Sign in",
    );
    if (choice === "Sign in") {
      await account.signIn();
    } else if (choice === "Sign out") {
      await account.signOut();
    }
  });

  register("ditfa.addSelectionToChat", () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    view.insertIntoComposer(snippet);
  });

  register("ditfa.explainSelection", async () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    view.reveal();
    await controller.send(`Explain this code:\n\n${snippet}`, []);
  });

  register("ditfa.reviewChanges", async () => {
    view.reveal();
    await controller.send(
      "Review my uncommitted changes. Point out bugs, missing edge cases, and anything that will not survive review.",
      [],
    );
  });

  register("ditfa.openTerminal", () => {
    const terminal = vscode.window.createTerminal({
      name: "Ditfa",
      cwd: resolveWorkspaceRoot(),
      iconPath: new vscode.ThemeIcon("sparkle"),
    });
    terminal.show();
    const executable = readSettings().executablePath || "ditfa";
    terminal.sendText(executable, false);
  });

  register("ditfa.restartServer", () => controller.reconnect("requested by the user"));

  register("ditfa.showLogs", () => {
    logger.show();
  });

  register("ditfa.locateBinary", async () => {
    const picked = await vscode.window.showOpenDialog({
      title: "Locate the ditfa executable",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Use this binary",
    });
    const chosen = picked?.[0];
    if (!chosen) {
      return;
    }
    await updateSetting("executablePath", chosen.fsPath, vscode.ConfigurationTarget.Global);
    await controller.reconnect("executable path changed");
  });

  register("ditfa.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "ditfa"),
  );
}

/**
 * Model, provider, and sandbox changes only take effect on a new thread, so ask
 * rather than silently discarding the current conversation.
 */
async function offerRestartForNewSettings(controller: DitfaController): Promise<void> {
  const entries = controller.threadSession?.snapshot().entries ?? [];
  if (entries.length === 0) {
    await controller.newThread();
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "New settings apply to the next thread. Start one now?",
    "Start new thread",
    "Keep this thread",
  );
  if (choice === "Start new thread") {
    await controller.newThread();
  }
}

/** Formats the active selection as a fenced snippet with a file reference. */
function captureSelection(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const language = editor.document.languageId;
  return `${relative}:${start}-${end}\n\n\`\`\`${language}\n${text}\n\`\`\``;
}
