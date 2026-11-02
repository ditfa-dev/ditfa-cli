import * as vscode from "vscode";

/** Offers Ditfa in the lightbulb menu wherever the editor reports a problem. */
export class DitfaCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const problems = context.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning,
    );
    if (problems.length === 0) {
      return [];
    }

    const action = new vscode.CodeAction("Fix with Ditfa", vscode.CodeActionKind.QuickFix);
    action.diagnostics = problems;
    action.command = {
      command: "ditfa.fixProblems",
      title: "Fix with Ditfa",
      arguments: [document.uri, range, problems.map((problem) => problem.message)],
    };
    return [action];
  }
}
