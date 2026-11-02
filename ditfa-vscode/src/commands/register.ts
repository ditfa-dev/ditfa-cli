import * as vscode from "vscode";

import type { DitfaController } from "../controller";
import type { ContextAttachment } from "../session/types";
import type { ChatViewProvider } from "../ui/chatViewProvider";
import type { Logger } from "../util/logger";
import { resolveWorkspaceRoot, updateSetting } from "../util/settings";

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

  register("ditfa.interrupt", () => controller.interrupt());

  register("ditfa.selectProvider", async () => {
    const providers = await controller.providerChoices();
    const current = controller.snapshot().header.provider;
    const picked = await vscode.window.showQuickPick(
      providers.map((provider) => ({
        id: provider.id,
        label: provider.name,
        description: provider.id === current ? "$(check) current" : provider.kind === "local" ? "local" : undefined,
        detail: provider.baseUrl ?? undefined,
      })),
      { title: "Ditfa: Select Provider", placeHolder: "Where should the agent's models come from?" },
    );
    if (picked && picked.id !== current) {
      await controller.selectProvider(picked.id);
    }
  });

  register("ditfa.signIn", async () => {
    view.reveal();
    await controller.setupProvider("ditfa");
  });

  register("ditfa.signOut", async () => {
    await controller.connect();
    await controller.accountManager?.signOut();
  });

  register("ditfa.showAccount", async () => {
    await controller.connect();
    const account = controller.accountManager;
    if (!account) {
      void vscode.window.showWarningMessage("The Ditfa engine is not running yet.");
      return;
    }
    const report = await account.describeUsage();
    const choice = await vscode.window.showInformationMessage(
      report,
      { modal: true },
      account.current.account ? "Sign out" : "Sign in",
    );
    if (choice === "Sign in") {
      await controller.setupProvider("ditfa");
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
    view.attachToComposer(snippet);
  });

  register("ditfa.addFileToChat", (resource) => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      view.attachToComposer({
        kind: "file",
        path: vscode.workspace.asRelativePath(uri, false),
        label: uri.path.split("/").pop() ?? uri.fsPath,
      });
    }
  });

  register("ditfa.explainSelection", async () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    view.reveal();
    await controller.send("Explain this code.", [snippet]);
  });

  // Goes through the same approval and diff path as everything else, so an
  // inline edit can never land without being reviewable.
  register("ditfa.inlineEdit", async () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select the code to change first.");
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: "Ditfa: Edit Selection",
      prompt: `Change ${snippet.label}`,
      placeHolder: "Describe the change",
      ignoreFocusOut: true,
    });
    if (instruction?.trim()) {
      view.reveal();
      await controller.send(
        `${instruction.trim()}\n\nEdit only the selected code unless the change requires more.`,
        [snippet],
      );
    }
  });

  register("ditfa.fixProblems", async (resource, range, messages) => {
    const uri = resource as vscode.Uri;
    const problems = (messages as string[]).map((message) => `- ${message}`).join("\n");
    const lines = range as vscode.Range;
    const relative = vscode.workspace.asRelativePath(uri, false);
    view.reveal();
    await controller.send(`Fix these problems:\n${problems}`, [
      {
        kind: "file",
        path: `${relative}:${lines.start.line + 1}`,
        label: uri.path.split("/").pop() ?? relative,
      },
    ]);
  });

  register("ditfa.fixTerminalOutput", async () => {
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    const output = (await vscode.env.clipboard.readText()).trim();
    if (!output) {
      void vscode.window.showInformationMessage("Select the terminal output first.");
      return;
    }
    view.reveal();
    await controller.send(`This came up in my terminal. Find the cause and fix it:\n\n\`\`\`\n${output}\n\`\`\``, []);
  });

  register("ditfa.reviewChanges", async () => {
    view.reveal();
    await controller.review();
  });

  register("ditfa.openTerminal", async () => {
    await controller.connect();
    const terminal = vscode.window.createTerminal({
      name: "Ditfa",
      cwd: resolveWorkspaceRoot(),
      iconPath: new vscode.ThemeIcon("sparkle"),
      shellPath: controller.executable,
    });
    terminal.show();
  });

  register("ditfa.restartServer", () => controller.reconnect("requested by the user"));

  register("ditfa.runDoctor", () => controller.runDoctor());

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
    await updateSetting("executablePath", chosen.fsPath);
    await controller.reconnect("executable path changed");
  });

  register("ditfa.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "ditfa"),
  );
}

/** Reads the active selection as an attachment. */
function captureSelection(): ContextAttachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const name = relative.split("/").pop() ?? relative;
  return {
    kind: "selection",
    path: relative,
    label: start === end ? `${name}:${start}` : `${name}:${start}-${end}`,
    range: { start, end },
    text: editor.document.getText(editor.selection),
    language: editor.document.languageId,
  };
}
