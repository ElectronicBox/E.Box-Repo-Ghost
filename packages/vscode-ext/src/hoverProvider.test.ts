import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createHoverProvider } from "./hoverProvider.js";
import type { RepoGhostOutput } from "./outputChannel.js";

vi.mock("vscode", () => ({
  MarkdownString: class {
    isTrusted = false;
    value = "";
    appendMarkdown(value: string) {
      this.value += value;
    }
  },
  Hover: class {
    constructor(public contents: unknown) {}
  },
}));

vi.mock("@repo-ghost/core", () => ({
  getLineBlame: vi.fn(),
}));

import { getLineBlame } from "@repo-ghost/core";

function output(): RepoGhostOutput {
  return {
    channel: { appendLine: vi.fn(), dispose: vi.fn() } as never,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("createHoverProvider", () => {
  it("returns commit details for the hovered source line", async () => {
    vi.mocked(getLineBlame).mockResolvedValue({
      lineContent: "return value;",
      commit: {
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        authorName: "Alice",
        authorEmail: "alice@example.test",
        authoredAt: "2025-01-01T00:00:00.000Z",
        message: "Fix value handling",
        filePath: "src/example.ts",
        additions: 1,
        deletions: 1,
      },
    });
    const provider = createHoverProvider(output());

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\src\\example.ts" } } as vscode.TextDocument,
      { line: 4, character: 2 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect(getLineBlame).toHaveBeenCalledWith("C:\\repo\\src\\example.ts", 5);
    expect(hover).toBeInstanceOf(vscode.Hover);
    expect((hover as vscode.Hover).contents).toBeInstanceOf(vscode.MarkdownString);
  });

  it("reports history failures without throwing", async () => {
    vi.mocked(getLineBlame).mockRejectedValue(new Error("git unavailable"));
    const logger = output();
    const provider = createHoverProvider(logger);

    await expect(
      provider.provideHover(
        { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
        { line: 0, character: 0 } as vscode.Position,
        {} as vscode.CancellationToken,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("Unable to load line history: git unavailable");
  });

  it("shows the enable-provider hint when LLM is disabled", async () => {
    vi.mocked(getLineBlame).mockResolvedValue(null);
    const provider = createHoverProvider(output(), { enableLlm: false });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect(hover).toBeInstanceOf(vscode.Hover);
  });

  it("adds the cached badge when a story cache hit is reported", async () => {
    vi.mocked(getLineBlame).mockResolvedValue({
      lineContent: "return value;",
      commit: {
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        authorName: "Alice",
        authorEmail: "alice@example.test",
        authoredAt: "2025-01-01T00:00:00.000Z",
        message: "Fix value handling",
        filePath: "src/example.ts",
        additions: 1,
        deletions: 1,
      },
    });
    const provider = createHoverProvider(output(), {
      getCachedBadge: vi.fn().mockResolvedValue(true),
    });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect((hover as vscode.Hover).contents).toMatchObject({ value: expect.stringContaining("⚡ cached") });
  });
});
