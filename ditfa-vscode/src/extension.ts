import * as vscode from "vscode";

import { registerCommands } from "./commands/register";
import { DitfaController } from "./controller";
import { ChatViewProvider } from "./ui/chatViewProvider";
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
  );

  registerCommands(context, controller, view, logger);

  // Connect eagerly so the first message does not pay for process startup, but
  // never block activation on it.
  void controller.connect().catch((error) => {
    logger.error("initial connection failed", error);
  });
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
