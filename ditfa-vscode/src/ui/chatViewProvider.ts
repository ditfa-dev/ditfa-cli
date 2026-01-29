import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { DitfaController } from "../controller";
import type { HostMessage, WebviewMessage } from "../session/types";
import type { Logger } from "../util/logger";

/**
 * The chat sidebar.
 *
 * The webview is a pure renderer: it holds no protocol knowledge and cannot
 * reach the network or the filesystem. Every action it can take is one of the
 * `WebviewMessage` variants handled below, which is what makes the strict CSP
 * on the document viable.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "ditfa.chatView";

  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: DitfaController,
    private readonly logger: Logger,
  ) {
    this.subscriptions.push(
      controller.onDidResetState(() => this.post({ type: "state", state: controller.snapshot() })),
      controller.onDidUpsertEntry((entry) => this.post({ type: "entryUpsert", entry })),
      controller.onDidPatchState((patch) => {
        if (patch.header) {
          this.post({ type: "header", header: patch.header });
        }
        if (patch.entries) {
          this.post({ type: "entries", entries: patch.entries });
        }
        if (patch.plan) {
          this.post({ type: "plan", plan: patch.plan, explanation: patch.planExplanation ?? null });
        }
        if (patch.tokenUsage !== undefined) {
          this.post({ type: "tokenUsage", usage: patch.tokenUsage });
        }
        if (patch.turnActive !== undefined) {
          this.post({ type: "turnActive", active: patch.turnActive });
        }
        if (patch.approvals) {
          this.post({ type: "approvals", approvals: patch.approvals });
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand("ditfa.chatView.focus");
    }
  }

  /** Appends text to the composer, revealing the panel first. */
  insertIntoComposer(text: string): void {
    this.reveal();
    this.post({ type: "composerInsert", text });
    this.post({ type: "focusComposer" });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post({ type: "state", state: this.controller.snapshot() });
        await this.controller.connect();
        break;

      case "send":
        await this.controller.send(message.text, message.attachments);
        break;

      case "interrupt":
        await this.controller.interrupt();
        break;

      case "newThread":
        await vscode.commands.executeCommand("ditfa.newThread");
        break;

      case "resumeThread":
        await vscode.commands.executeCommand("ditfa.resumeThread");
        break;

      case "approval":
        this.controller.approvalService?.resolve(message.answer);
        break;

      case "openDiff":
        await this.controller.openDiff(message.entryId, message.path);
        break;

      case "openFile": {
        const uri = vscode.Uri.file(message.path);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        if (message.line !== undefined) {
          const position = new vscode.Position(Math.max(0, message.line - 1), 0);
          editor.revealRange(new vscode.Range(position, position));
          editor.selection = new vscode.Selection(position, position);
        }
        break;
      }

      case "selectModel":
        await vscode.commands.executeCommand("ditfa.selectModel");
        break;

      case "selectApprovalMode":
        await vscode.commands.executeCommand("ditfa.selectApprovalMode");
        break;

      case "signIn":
        await vscode.commands.executeCommand("ditfa.signIn");
        break;

      case "showAccount":
        await vscode.commands.executeCommand("ditfa.showAccount");
        break;

      case "showLogs":
        this.logger.show();
        break;

      case "retryConnection":
        await this.controller.reconnect("requested from the chat panel");
        break;

      case "requestFileSuggestions": {
        const results = await this.controller.searchFiles(message.query);
        this.post({ type: "fileSuggestions", token: message.token, results });
        break;
      }

      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        break;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );

    // No remote origins, no inline scripts, no eval. Styles are allowed inline
    // because VS Code injects its own theme variables that way.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${style}" rel="stylesheet" />
    <title>Ditfa Code</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }
}
