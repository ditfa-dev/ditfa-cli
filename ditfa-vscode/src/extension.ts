import * as vscode from "vscode";

import { registerCommands } from "./commands/register";
import { DitfaController } from "./controller";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { DitfaCodeActions } from "./ui/codeActions";
import { Logger } from "./util/logger";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info(`Ditfa Code ${context.extension.packageJSON.version ?? "dev"} activating`);

  const controller = new DitfaController(context, logger);
  const view = new ChatViewProvider(context, controller, logger);
  context.subscriptions.push(controller, view);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, view, {
      // Keep the transcript when the user switches to another sidebar view.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new DitfaCodeActions(), {
      providedCodeActionKinds: DitfaCodeActions.kinds,
    }),
  );

  registerCommands(context, controller, view, logger);
  // The engine starts with the panel, not with the editor: activation stays cheap
  // in every window the user never asks Ditfa anything in.
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
