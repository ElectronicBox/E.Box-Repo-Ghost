import * as vscode from "vscode";

export interface RepoGhostOutput {
  readonly channel: vscode.OutputChannel;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  dispose(): void;
}

function append(channel: vscode.OutputChannel, level: string, message: string): void {
  channel.appendLine(`[${level}] ${message}`);
}

export function createOutputChannel(
  channel: vscode.OutputChannel = vscode.window.createOutputChannel("repo-ghost"),
): RepoGhostOutput {
  return {
    channel,
    info: (message) => append(channel, "info", message),
    warn: (message) => append(channel, "warn", message),
    error: (message) => append(channel, "error", message),
    dispose: () => channel.dispose(),
  };
}
