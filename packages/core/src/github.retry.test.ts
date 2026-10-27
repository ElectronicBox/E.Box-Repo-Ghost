import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphqlDefaults, graphqlRequest } = vi.hoisted(() => ({
  graphqlDefaults: vi.fn(),
  graphqlRequest: vi.fn(),
}));

vi.mock("@octokit/graphql", () => ({
  graphql: { defaults: graphqlDefaults },
}));

import { enrichCommit } from "./github.js";

describe("GitHub request retry and timeout behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    graphqlDefaults.mockReturnValue(graphqlRequest);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exhausts rate-limit retries and redacts the final error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    graphqlRequest.mockRejectedValue(new Error("rate limit exceeded"));
    const pending = enrichCommit("0123456789abcdef0123456789abcdef01234567", {
      githubToken: "ghp_retry_token",
      requestTimeoutMs: 1_000,
      repository: { owner: "example", name: "repo" },
    });
    const result = expect(pending).rejects.toThrow("GitHub enrichment failed; details redacted.");

    await vi.runAllTimersAsync();
    await result;
    expect(graphqlRequest).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenCalledWith(
      "repo-ghost: GitHub enrichment failed; request details redacted.",
    );
  });

  it("redacts timeout failures without exposing request details", async () => {
    const token = "ghp_timeout_token";
    graphqlRequest.mockRejectedValue(Object.assign(new Error(`timeout ${token}`), {
      name: "TimeoutError",
    }));

    await expect(
      enrichCommit("0123456789abcdef0123456789abcdef01234567", {
        githubToken: token,
        requestTimeoutMs: 1,
        repository: { owner: "example", name: "repo" },
      }),
    ).rejects.toThrow("GitHub enrichment failed; details redacted.");
  });
});
