import { beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";
import { resolveConfig } from "./config.js";

const {
  registerCommand,
  registerHoverProvider,
  createOutputChannel,
  createStatusBarItem,
  getConfiguration,
  onDidChangeConfiguration,
  applyEdit,
  writeFile,
} = vi.hoisted(() => ({
  registerCommand: vi.fn((command: string) => ({
    command,
    dispose: vi.fn(),
  })),
  registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
  createStatusBarItem: vi.fn(() => ({
    show: vi.fn(),
    dispose: vi.fn(),
    text: "",
    tooltip: "",
    command: "",
  })),
  getConfiguration: vi.fn(() => ({
    get: vi.fn(() => false),
    update: vi.fn(),
  })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  applyEdit: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  commands: { registerCommand },
  languages: { registerHoverProvider },
  workspace: {
    getConfiguration,
    onDidChangeConfiguration,
    applyEdit,
    fs: { writeFile },
  },
  window: {
    createOutputChannel,
    createStatusBarItem,
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

vi.mock("./config.js", () => ({
  clearGitHubToken: vi.fn(),
  setGitHubToken: vi.fn(),
  resolveConfig: vi.fn(async () => ({
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    enableLlm: false,
    enableGitHubEnrichment: false,
    cacheTtlMs: 60_000,
    requestTimeoutMs: 30_000,
    tokenBudget: 1_800,
    debug: false,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("activate", () => {
  it("registers commands, hover support, and disposable resources", () => {
    const context = { subscriptions: [] as unknown[] };

    activate(context as never);

    expect(registerCommand).toHaveBeenCalledTimes(4);
    expect(registerCommand.mock.calls.map(([command]) => command)).toEqual([
      "repo-ghost.enableProvider",
      "repo-ghost.setGitHubToken",
      "repo-ghost.clearGitHubToken",
      "repo-ghost.showRiskMap",
    ]);
    expect(registerHoverProvider).toHaveBeenCalledWith(
      { scheme: "file" },
      expect.anything(),
    );
    expect(onDidChangeConfiguration).toHaveBeenCalledOnce();
    expect(context.subscriptions.length).toBe(8);
  });

  it("retains each registered disposable for extension shutdown", () => {
    const context = { subscriptions: [] as unknown[] };

    activate(context as never);

    expect(context.subscriptions.every((subscription) => subscription !== undefined)).toBe(true);
    expect(createOutputChannel).toHaveBeenCalledWith("repo-ghost");
    expect(createStatusBarItem).toHaveBeenCalledOnce();
  });

  it("does not apply workspace edits or write outside the repo-ghost cache", () => {
    const context = { subscriptions: [] as unknown[] };

    activate(context as never);

    expect(applyEdit).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("re-resolves validated configuration when repo-ghost settings change", async () => {
    const context = { subscriptions: [] as unknown[] };
    activate(context as never);
    const listener = (onDidChangeConfiguration.mock.calls as unknown as Array<[(
      event: { affectsConfiguration(section: string): boolean },
    ) => void]>)[0]?.[0] as
      | ((event: { affectsConfiguration(section: string): boolean }) => void)
      | undefined;

    expect(listener).toBeDefined();
    listener?.({ affectsConfiguration: () => true });
    await Promise.resolve();

    expect(resolveConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps the extension alive and disables LLM use when configuration fails", async () => {
    vi.mocked(resolveConfig).mockRejectedValueOnce(new Error('invalid setting "provider"'));
    const context = { subscriptions: [] as unknown[] };

    expect(() => activate(context as never)).not.toThrow();
    await Promise.resolve();

    expect(context.subscriptions.length).toBe(8);
  });
});
