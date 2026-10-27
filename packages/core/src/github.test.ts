import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphqlDefaults, graphqlRequest } = vi.hoisted(() => ({
  graphqlDefaults: vi.fn(),
  graphqlRequest: vi.fn(),
}));

vi.mock("@octokit/graphql", () => ({
  graphql: { defaults: graphqlDefaults },
}));

import { enrichCommit } from "./github.js";

describe("enrichCommit error redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphqlDefaults.mockReturnValue(graphqlRequest);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not leak the token in a timed-out request's thrown message or stack", async () => {
    const token = "ghp_sensitive_test_token";
    const upstreamError = Object.assign(new Error(`Timeout while using ${token}`), {
      headers: { authorization: `token ${token}` },
    });
    upstreamError.name = "TimeoutError";
    upstreamError.stack = `TimeoutError: ${token}`;
    graphqlRequest.mockRejectedValueOnce(upstreamError);

    const caught = await enrichCommit("0123456789abcdef0123456789abcdef01234567", {
      githubToken: token,
      requestTimeoutMs: 30_000,
      repository: { owner: "example", name: "repo" },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("Expected enrichCommit to reject with an Error.");
    }
    expect(caught.message).not.toContain(token);
    expect(caught.stack).not.toContain(token);
    expect(caught.message).toBe("GitHub enrichment failed; details redacted.");
    expect(caught).not.toHaveProperty("headers");
  });
});
