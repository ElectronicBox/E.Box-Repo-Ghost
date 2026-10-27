import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { runCli, ENABLE_PROVIDER_MESSAGE } from "./cli.js";

vi.mock("@repo-ghost/core", () => ({
  buildPrompt: vi.fn(() => "EXACT PROMPT"),
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

describe("repo-ghost CLI", () => {
  it("prints the enable-provider message and never calls the LLM when disabled", async () => {
    const output = capture();
    const code = await runCli(["explain", "src/a.ts:2"], {
      stdout: output.stream,
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      env: {},
    });

    expect(code).toBe(0);
    expect(output.text()).toContain(ENABLE_PROVIDER_MESSAGE);
    const { summarize } = await import("@repo-ghost/core");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("prints the exact prompt in dry-run mode without sending it", async () => {
    const output = capture();
    const code = await runCli(["explain", "src/a.ts:2", "--dry-run"], {
      stdout: output.stream,
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      env: { REPO_GHOST_ENABLE_LLM: "1" },
    });

    expect(code).toBe(0);
    expect(output.text()).toBe("EXACT PROMPT\n");
    const { summarize } = await import("@repo-ghost/core");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("uses GITHUB_TOKEN only as the CLI GitHub credential and never prints it", async () => {
    const output = capture();
    const token = "ghp_cli_secret_should_never_print";
    await runCli(["explain", "src/a.ts:2"], {
      stdout: output.stream,
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      env: { GITHUB_TOKEN: token },
    });

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

  it("returns a nonzero exit code for an invalid location", async () => {
    const error = capture();
    const code = await runCli(["explain", "src/a.ts"], {
      stderr: error.stream,
      env: {},
    });

    expect(code).toBe(1);
    expect(error.text()).toContain("<file>:<positive-line>");
  });
});
