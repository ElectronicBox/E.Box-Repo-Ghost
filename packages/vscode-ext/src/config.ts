import * as vscode from "vscode";
import { z } from "zod";
import { ConfigSchema, type Config } from "@repo-ghost/core";

const SETTINGS_SECTION = "repoGhost";
const GITHUB_TOKEN_SECRET = "repo-ghost.githubToken";

function providerDefaultBaseUrl(provider: Config["provider"]): string {
  switch (provider) {
    case "ollama":
      return "http://localhost:11434";
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai-compatible":
      return "https://api.openai.com";
  }
}

function providerDefaultModel(provider: Config["provider"]): string {
  switch (provider) {
    case "ollama":
      return "llama3.2";
    case "anthropic":
      return "claude-3-5-sonnet-latest";
    case "openai-compatible":
      return "gpt-4o-mini";
  }
}

function normalizeZodIssue(error: unknown): { path: string; message: string } {
  if (error instanceof z.ZodError && error.issues.length > 0) {
    const issue = error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return {
      path,
      message: issue.message,
    };
  }

  return {
    path: "<root>",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function resolveConfig(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<Config> {
  const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const provider = settings.get<Config["provider"]>("provider", "ollama");
  const secretGithubToken = await context.secrets.get(GITHUB_TOKEN_SECRET);
  const githubToken = secretGithubToken?.trim()
    ? secretGithubToken.trim()
    : process.env.GITHUB_TOKEN?.trim() || undefined;
  const enableGitHubEnrichment = settings.get<boolean>("enableGitHubEnrichment", false);

  if (enableGitHubEnrichment && !githubToken) {
    output.appendLine(
      "GitHub enrichment is enabled but no token is available. Set one with repo-ghost.setGitHubToken or GITHUB_TOKEN.",
    );
  }

  const explicitApiKey = settings.get<string | undefined>("apiKey");
  const providerEnvironmentKey =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY?.trim() || undefined
      : provider === "openai-compatible"
        ? process.env.OPENAI_API_KEY?.trim() || undefined
        : undefined;
  // Consent model: modal-only. `repoGhost.enableLlm` is application-scoped and must be
  // written only by the enableProvider flow, with the setting description set to:
  // "Enable via repo-ghost.enableProvider".
  const configuredBaseUrl = settings.get<string | undefined>("baseUrl");
  const config = {
    provider,
    model: settings.get<string>("model", providerDefaultModel(provider)),
    baseUrl: configuredBaseUrl || providerDefaultBaseUrl(provider),
    apiKey: explicitApiKey?.trim() || providerEnvironmentKey || undefined,
    githubToken,
    enableLlm: settings.get<boolean>("enableLlm", false),
    enableGitHubEnrichment,
    cacheTtlMs: settings.get<number>("cacheTtlMs", 30 * 24 * 60 * 60 * 1_000),
    requestTimeoutMs: settings.get<number>("requestTimeoutMs", 30_000),
    tokenBudget: settings.get<number>("tokenBudget", 1_800),
    debug: settings.get<boolean>("debug", false),
  };

  // The returned Config contains secrets (githubToken, apiKey). Never serialize, log, or cache this object.
  try {
    return ConfigSchema.parse(config);
  } catch (error) {
    const { path, message } = normalizeZodIssue(error);
    const invalidSettingText = `repo-ghost: invalid setting "${path}" — ${message}`;
    output.appendLine(invalidSettingText);
    void vscode.window.showErrorMessage(invalidSettingText);
    throw error;
  }
}

export async function setGitHubToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "Set repo-ghost GitHub token",
    prompt: "Token is stored in VS Code SecretStorage and is never logged.",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) return;

  const cleanedToken = token.trim();
  if (!cleanedToken) {
    throw new Error("GitHub token must not be empty.");
  }

  await context.secrets.store(GITHUB_TOKEN_SECRET, cleanedToken);
}

export async function clearGitHubToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(GITHUB_TOKEN_SECRET);
}
