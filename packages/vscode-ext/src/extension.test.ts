import { beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";

const {
  registerCommand,
  registerHoverProvider,
  createOutputChannel,
  createStatusBarItem,
  getConfiguration,
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
  applyEdit: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  commands: { registerCommand },
  languages: { registerHoverProvider },
  workspace: { getConfiguration, applyEdit, fs: { writeFile } },
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
    expect(context.subscriptions.length).toBe(7);
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
});
