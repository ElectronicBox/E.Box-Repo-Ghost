import { beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { runCli, ENABLE_PROVIDER_MESSAGE } from "./cli.js";

const { buildPrompt, enrichCommit, getFileHistory, getLineBlame, getRiskMap, summarize } =
  vi.hoisted(() => ({
    buildPrompt: vi.fn(() => "EXACT PROMPT"),
    enrichCommit: vi.fn(async () => ({ pullRequests: [], issues: [] })),
    getFileHistory: vi.fn(async function* () {
      yield {
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        authorName: "Alice",
        authorEmail: "alice@example.test",
        authoredAt: "2025-01-01T00:00:00.000Z",
        message: "Initial",
        filePath: "src/a.ts",
        additions: 1,
        deletions: 0,
      };
    }),
    getLineBlame: vi.fn(async () => ({
      lineContent: "return value;",
      commit: {
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        authorName: "Alice",
        authorEmail: "alice@example.test",
        authoredAt: "2025-01-01T00:00:00.000Z",
        message: "Initial",
        filePath: "src/a.ts",
        additions: 1,
        deletions: 0,
      },
    })),
    getRiskMap: vi.fn(async () => [{ filePath: "src/a.ts", riskScore: 50 }]),
    summarize: vi.fn(async () => "summary"),
  }));

vi.mock("@repo-ghost/core", () => ({
  buildPrompt,
  enrichCommit,
  getFileHistory,
  getLineBlame,
  getRiskMap,
  summarize,
}));

function capture(): { stream: Writable; text: () => string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    text: () => value,
  };
}

function silentStream(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

describe("repo-ghost CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichCommit.mockResolvedValue({ pullRequests: [], issues: [] });
    summarize.mockResolvedValue("summary");
  });

  it("prints the enable-provider message and never calls the LLM when disabled", async () => {
    const output = capture();
    const code = await runCli(["explain", "src/a.ts:2"], {
      stdout: output.stream,
      stderr: silentStream(),
      env: {},
    });

    expect(code).toBe(0);
    expect(output.text()).toContain(ENABLE_PROVIDER_MESSAGE);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("fails fast with the consent message when disabled and the file is missing", async () => {
    const output = capture();
    const code = await runCli(["explain", "missing.ts:2"], {
      stdout: output.stream,
      stderr: silentStream(),
      env: {},
    });

    expect(code).toBe(0);
    expect(output.text()).toContain(ENABLE_PROVIDER_MESSAGE);
    expect(getLineBlame).not.toHaveBeenCalled();
    expect(getFileHistory).not.toHaveBeenCalled();
  });

  it("prints the exact prompt in dry-run mode without sending it", async () => {
    const output = capture();
    const code = await runCli(["explain", "src/a.ts:2", "--dry-run"], {
      stdout: output.stream,
      stderr: silentStream(),
      env: { REPO_GHOST_ENABLE_LLM: "1" },
    });

    expect(code).toBe(0);
    expect(output.text()).toBe("EXACT PROMPT\n");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("includes enriched PR and issue context when GITHUB_TOKEN is set", async () => {
    const output = capture();
    const token = "ghp_cli_secret_should_never_print";
    enrichCommit.mockResolvedValueOnce({
      pullRequests: [{
        number: 7,
        title: "Fix auth",
        body: "Improve auth handling",
        url: "https://github.com/example/repo/pull/7",
        state: "MERGED",
        mergedAt: "2025-01-01T00:00:00Z",
        comments: [],
      }] as never[],
      issues: [{
        number: 8,
        title: "Auth issue",
        body: "Track auth bug",
        url: "https://github.com/example/repo/issues/8",
        state: "OPEN",
        comments: [],
      }] as never[],
    });
    summarize.mockResolvedValueOnce("PR #7 fixed issue #8.");

    const code = await runCli(["explain", "src/a.ts:2"], {
      stdout: output.stream,
      stderr: silentStream(),
      env: { REPO_GHOST_ENABLE_LLM: "1", GITHUB_TOKEN: token },
    });

    expect(code).toBe(0);
    expect(output.text()).toContain("PR #7");
    expect(output.text()).toContain("issue #8");
    expect(enrichCommit).toHaveBeenCalledWith(
      "a1b2c3d4e5f6789012345678901234567890abcd",
      expect.objectContaining({ githubToken: token }),
    );
    expect(output.text()).not.toContain(token);
  });

  it("supports JSON risk-map output", async () => {
    const output = capture();
    expect(await runCli(["risk-map", "src", "--json"], { stdout: output.stream, env: {} })).toBe(0);
    expect(JSON.parse(output.text())).toEqual([{ filePath: "src/a.ts", riskScore: 50 }]);
  });

  it("supports JSON output for the disabled-provider response", async () => {
    const output = capture();
    const code = await runCli(["explain", "src/a.ts:2", "--json"], {
      stdout: output.stream,
      env: {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      enabled: false,
      message: ENABLE_PROVIDER_MESSAGE,
    });
  });

  it("returns a nonzero exit code for an invalid location when enabled", async () => {
    const error = capture();
    const code = await runCli(["explain", "src/a.ts"], {
      stderr: error.stream,
      env: { REPO_GHOST_ENABLE_LLM: "1" },
    });

    expect(code).toBe(1);
    expect(error.text()).toContain("<file>:<positive-line>");
  });
});
