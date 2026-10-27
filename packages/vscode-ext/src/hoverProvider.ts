import * as vscode from "vscode";
import { getLineBlame } from "@repo-ghost/core";
import type { RepoGhostOutput } from "./outputChannel.js";

export interface HoverProviderOptions {
  enableLlm?: boolean;
  getCachedBadge?: (filePath: string, line: number) => Promise<boolean>;
}

export function createHoverProvider(
  output: RepoGhostOutput,
  options: HoverProviderOptions = {},
): vscode.HoverProvider {
  return {
    async provideHover(document, position) {
      const line = position.line + 1;
      try {
        const blame = await getLineBlame(document.uri.fsPath, line);
        if (blame === null) {
          if (options.enableLlm === false) {
            const hint = new vscode.MarkdownString(
              "Repo Ghost is disabled. Run `Repo Ghost: Enable Provider` to enable summaries.",
            );
            hint.isTrusted = false;
            return new vscode.Hover(hint);
          }
          return undefined;
        }

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = false;
        if (options.enableLlm === false) {
          markdown.appendMarkdown(
            "_Enable a provider with `Repo Ghost: Enable Provider` for LLM summaries._\n\n",
          );
        }
        if (options.getCachedBadge !== undefined) {
          try {
            if (await options.getCachedBadge(document.uri.fsPath, line)) {
              markdown.appendMarkdown("⚡ cached\n\n");
            }
          } catch (error) {
            output.warn(
              `Unable to inspect cached story: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            );
          }
        }
        markdown.appendMarkdown(`**${blame.commit.message}**\n\n`);
        markdown.appendMarkdown(
          `Commit: [\`${blame.commit.sha.slice(0, 12)}\`](command:git.show?${encodeURIComponent(
            JSON.stringify([blame.commit.sha]),
          )})\n\n`,
        );
        markdown.appendMarkdown(`Author: ${blame.commit.authorName}\n\n`);
        markdown.appendMarkdown(`Authored: ${blame.commit.authoredAt}`);
        return new vscode.Hover(markdown);
      } catch (error) {
        output.warn(
          `Unable to load line history: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return undefined;
      }
    },
  };
}
