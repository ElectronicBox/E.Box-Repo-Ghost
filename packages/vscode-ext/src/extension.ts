import * as vscode from "vscode";
import { clearGitHubToken, setGitHubToken } from "./config.js";
import { createHoverProvider } from "./hoverProvider.js";
import { createOutputChannel } from "./outputChannel.js";
import { openRiskMapView } from "./riskMapView.js";
import { createStatusBar } from "./statusBar.js";

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
  statusBar.setEnabled(
    vscode.workspace.getConfiguration("repoGhost").get<boolean>("enableLlm", false),
  );
  context.subscriptions.push(
    output,
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
      createHoverProvider(output, {
        enableLlm: vscode.workspace
          .getConfiguration("repoGhost")
          .get<boolean>("enableLlm", false),
      }),
    ),
  );
}

export function deactivate(): void {}
