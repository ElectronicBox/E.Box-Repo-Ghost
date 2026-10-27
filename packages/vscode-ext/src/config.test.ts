import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { resolveConfig, setGitHubToken } from "./config.js";

const { settingsStore, secretStore } = vi.hoisted(() => ({
  settingsStore: {} as Record<string, unknown>,
  secretStore: {} as Record<string, string>,
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        if (Object.prototype.hasOwnProperty.call(settingsStore, key)) {
          return settingsStore[key] as T;
        }
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

function createContext() {
  return {
    secrets: {
      get: vi.fn(async (key: string) => secretStore[key]),
      store: vi.fn(async (key: string, value: string) => {
        secretStore[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        delete secretStore[key];
      }),
    },
  } as any;
}

function createOutput() {
  return {
    appendLine: vi.fn(),
  } as any;
}

beforeEach(() => {
  Object.keys(settingsStore).forEach((key) => delete settingsStore[key]);
  Object.keys(secretStore).forEach((key) => delete secretStore[key]);
  delete process.env.GITHUB_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConfig", () => {
  it("resolves default values for the default provider, LLM toggle, and GitHub enrichment", async () => {
    const config = await resolveConfig(createContext(), createOutput());

    expect(config.provider).toBe("ollama");
    expect(config.enableLlm).toBe(false);
    expect(config.enableGitHubEnrichment).toBe(false);
    expect(config.apiKey).toBeUndefined();
  });

  it("prefers the SecretStorage GitHub token over the environment variable", async () => {
    process.env.GITHUB_TOKEN = "env-token";
    secretStore["repo-ghost.githubToken"] = "stored-token";

    const config = await resolveConfig(createContext(), createOutput());

    expect(config.githubToken).toBe("stored-token");
  });

  it("resolves the API key from explicit settings before the provider env vars", async () => {
    settingsStore.provider = "anthropic";
    process.env.ANTHROPIC_API_KEY = "anthropic-env-key";

    let config = await resolveConfig(createContext(), createOutput());
    expect(config.apiKey).toBe("anthropic-env-key");

    settingsStore.apiKey = "anthropic-setting-key";
    config = await resolveConfig(createContext(), createOutput());
    expect(config.apiKey).toBe("anthropic-setting-key");

    settingsStore.provider = "openai-compatible";
    process.env.OPENAI_API_KEY = "openai-env-key";
    delete settingsStore.apiKey;
    config = await resolveConfig(createContext(), createOutput());
    expect(config.apiKey).toBe("openai-env-key");

    settingsStore.provider = "ollama";
    config = await resolveConfig(createContext(), createOutput());
    expect(config.apiKey).toBeUndefined();
  });

  it("reports invalid settings with the exact Zod path for the provider field", async () => {
    settingsStore.provider = "not-a-provider";
    const output = createOutput();

    await expect(resolveConfig(createContext(), output)).rejects.toThrow();
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('repo-ghost: invalid setting "provider"'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('provider'),
    );
  });

  it("does not leak a GitHub token via console.* or output logging", async () => {
    const token = "ghp_test_token_value_1234567890";
    secretStore["repo-ghost.githubToken"] = token;
    const output = createOutput();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = await resolveConfig(createContext(), output);

    expect(config.githubToken).toBe(token);

    const loggedText = [
      ...logSpy.mock.calls.flat().map(String),
      ...warnSpy.mock.calls.flat().map(String),
      ...errorSpy.mock.calls.flat().map(String),
      ...output.appendLine.mock.calls.flat().map(String),
    ].join("\n");

    expect(loggedText).not.toContain(token);
    expect(config.githubToken).toBe(token);
  });
});

describe("setGitHubToken", () => {
  it("throws when the user submits an empty or whitespace-only token", async () => {
    const context = createContext();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("   ");

    await expect(setGitHubToken(context)).rejects.toThrow("GitHub token must not be empty.");
    expect(context.secrets.store).not.toHaveBeenCalled();
  });

  it("returns without writing when the prompt is cancelled", async () => {
    const context = createContext();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    await expect(setGitHubToken(context)).resolves.toBeUndefined();
    expect(context.secrets.store).not.toHaveBeenCalled();
  });
});
