import * as vscode from "vscode";
import { clearGitHubToken, resolveConfig, setGitHubToken } from "./config.js";
import { createHoverProvider } from "./hoverProvider.js";
import { createOutputChannel } from "./outputChannel.js";
import { openRiskMapView } from "./riskMapView.js";
import { createStatusBar } from "./statusBar.js";
import type { Config } from "@repo-ghost/core";

const OUTPUT_CHANNEL_NAME = "repo-ghost";

async function enableProvider(): Promise<void> {
  const provider = await vscode.window.showQuickPick(
    [
      { label: "Ollama", value: "ollama" },
      { label: "Anthropic", value: "anthropic" },
      { label: "OpenAI-compatible", value: "openai-compatible" },
    ],
    {
      title: "Enable repo-ghost provider",
      placeHolder: "Choose the provider to enable",
    },
  );
  if (!provider) return;

  const settings = vscode.workspace.getConfiguration("repoGhost");
  await settings.update("provider", provider.value, vscode.ConfigurationTarget.Global);
  await settings.update("enableLlm", true, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`repo-ghost enabled with ${provider.label}.`);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = createOutputChannel(vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME));
  const statusBar = createStatusBar(context);
  let config: Config = {
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    enableLlm: false,
    enableGitHubEnrichment: false,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1_000,
    requestTimeoutMs: 30_000,
    tokenBudget: 1_800,
    debug: false,
  };
  const refreshConfig = async (): Promise<void> => {
    try {
      config = await resolveConfig(context, output.channel);
      statusBar.setEnabled(config.enableLlm);
    } catch {
      config = { ...config, enableLlm: false };
      statusBar.setEnabled(false);
      output.error("Unable to resolve repo-ghost settings; LLM summaries are disabled.");
    }
  };
  void refreshConfig();
  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("repoGhost")) void refreshConfig();
    }),
    vscode.commands.registerCommand("repo-ghost.enableProvider", async () => {
      await enableProvider();
      statusBar.setEnabled(true);
    }),
    vscode.commands.registerCommand("repo-ghost.setGitHubToken", async () => {
      try {
        await setGitHubToken(context);
        void vscode.window.showInformationMessage("repo-ghost GitHub token saved.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save GitHub token.";
        void vscode.window.showErrorMessage(`repo-ghost: ${message}`);
      }
    }),
    vscode.commands.registerCommand("repo-ghost.clearGitHubToken", async () => {
      await clearGitHubToken(context);
      void vscode.window.showInformationMessage("repo-ghost GitHub token cleared.");
    }),
    vscode.commands.registerCommand("repo-ghost.showRiskMap", async () => {
      const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!directory) {
        void vscode.window.showErrorMessage("repo-ghost: open a workspace to view its risk map.");
        return;
      }
      await openRiskMapView(context, directory, output);
    }),
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      createHoverProvider(output, { getConfig: () => config }),
    ),
  );
}

export function deactivate(): void {}
