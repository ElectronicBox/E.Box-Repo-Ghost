import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createHoverProvider } from "./hoverProvider.js";
import type { RepoGhostOutput } from "./outputChannel.js";

const { getLineBlame, getFileHistory, summarize, enrichCommit } = vi.hoisted(() => ({
  getLineBlame: vi.fn(),
  getFileHistory: vi.fn(),
  summarize: vi.fn(),
  enrichCommit: vi.fn(),
}));

vi.mock("vscode", () => ({
  MarkdownString: class {
    isTrusted = false;
    value = "";
    constructor(value?: string) {
      this.value = value ?? "";
    }
    appendMarkdown(value: string) {
      this.value += value;
    }
  },
  Hover: class {
    constructor(public contents: unknown) {}
  },
}));

vi.mock("@repo-ghost/core", () => ({
  createStoryCache: vi.fn(),
  enrichCommit,
  getFileHistory,
  getLineBlame,
  summarize,
}));

import type { Config, LineStory, StoryCache } from "@repo-ghost/core";

function output(): RepoGhostOutput {
  return {
    channel: { appendLine: vi.fn(), dispose: vi.fn() } as never,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  };
}

function config(enableLlm: boolean): Config {
  return {
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    enableLlm,
    enableGitHubEnrichment: false,
    cacheTtlMs: 60_000,
    requestTimeoutMs: 30_000,
    tokenBudget: 1_800,
    debug: false,
  };
}

function blame() {
  return {
    lineContent: "return value;",
    repositoryRoot: "C:\\repo",
    headSha: "0123456789abcdef0123456789abcdef01234567",
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
  };
}

function cache(get: StoryCache["get"]): StoryCache {
  return {
    get,
    set: vi.fn(),
    clear: vi.fn(),
    invalidateOnHeadChange: vi.fn(),
  };
}

describe("createHoverProvider", () => {
  it("returns nothing when blame is unavailable", async () => {
    getLineBlame.mockResolvedValue(null);
    const provider = createHoverProvider(output(), { getConfig: () => config(true) });

    await expect(
      provider.provideHover(
        { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
        { line: 0, character: 0 } as vscode.Position,
        {} as vscode.CancellationToken,
      ),
    ).resolves.toBeUndefined();
  });

  it("shows the enable-provider hint and never calls the LLM when disabled", async () => {
    getLineBlame.mockResolvedValue(blame());
    const provider = createHoverProvider(output(), { getConfig: () => config(false) });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect(hover).toBeInstanceOf(vscode.Hover);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("renders a cached story without calling the LLM", async () => {
    getLineBlame.mockResolvedValue(blame());
    const story = {
      ...blame(),
      filePath: "C:\\repo\\file.ts",
      line: 1,
      pullRequests: [],
      issues: [],
      backstory: "Cached explanation.",
      cached: true,
    } satisfies LineStory;
    const get = vi.fn().mockResolvedValue(story);
    const provider = createHoverProvider(output(), {
      getConfig: () => config(true),
      getCache: () => cache(get),
    });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect(get).toHaveBeenCalledWith(
      "C:\\repo\\file.ts",
      "return value;",
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect((hover as vscode.Hover).contents).toMatchObject({
      value: expect.stringContaining("⚡ cached"),
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes and caches a story on a cache miss", async () => {
    getLineBlame.mockResolvedValue(blame());
    getFileHistory.mockReturnValue((async function* () {
      yield blame().commit;
    })());
    summarize.mockResolvedValue("New explanation.");
    enrichCommit.mockResolvedValue({ pullRequests: [], issues: [] });
    const set = vi.fn();
    const provider = createHoverProvider(output(), {
      getConfig: () => config(true),
      getCache: () => ({
        ...cache(vi.fn().mockResolvedValue(undefined)),
        set,
      }),
    });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    expect((hover as vscode.Hover).contents).toMatchObject({
      value: expect.stringContaining("New explanation."),
    });
  });

  it("returns a sanitized history-unavailable hover on failure", async () => {
    getLineBlame.mockRejectedValue(new Error("token ghp_sensitive"));
    const logger = output();
    const provider = createHoverProvider(logger, { getConfig: () => config(true) });

    const hover = await provider.provideHover(
      { uri: { fsPath: "C:\\repo\\file.ts" } } as vscode.TextDocument,
      { line: 0, character: 0 } as vscode.Position,
      {} as vscode.CancellationToken,
    );

    expect((hover as vscode.Hover).contents).toMatchObject({
      value: "_History unavailable for this line._",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Unable to load line story; history unavailable.",
    );
  });
});
