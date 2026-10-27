import * as vscode from "vscode";

export interface StatusBarController extends vscode.Disposable {
  setEnabled(enabled: boolean): void;
}

export function createStatusBar(context: vscode.ExtensionContext): StatusBarController {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "repo-ghost.enableProvider";
  item.tooltip = "Repo Ghost";
  item.show();
  context.subscriptions.push(item);

  return {
    setEnabled(enabled) {
      item.text = enabled ? "$(check) Repo Ghost" : "$(circle-slash) Repo Ghost";
      item.tooltip = enabled
        ? "Repo Ghost is enabled"
        : "Repo Ghost is disabled; click to enable a provider";
    },
    dispose() {
      item.dispose();
    },
  };
}
