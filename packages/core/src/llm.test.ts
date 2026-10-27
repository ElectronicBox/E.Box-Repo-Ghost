import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphqlDefaults, graphqlRequest } = vi.hoisted(() => ({
  graphqlDefaults: vi.fn(),
  graphqlRequest: vi.fn(),
}));

vi.mock("@octokit/graphql", () => ({
  graphql: { defaults: graphqlDefaults },
}));

import { enrichCommit } from "./github.js";
import { buildPrompt, summarize } from "./llm.js";
import { validateStory } from "./validate.js";
import { ConfigSchema, type RawStory } from "./types.js";

const emptyStory: RawStory = {
  commits: [],
  pullRequests: [],
  issues: [],
  lineContent: "",
};

const story: RawStory = {
  commits: [
    {
      sha: "a1b2c3d4e5f6789012345678901234567890abcd",
      authorName: "Sarah",
      authorEmail: "sarah@example.test",
      authoredAt: "2024-03-01T12:00:00Z",
      message: "Fix webhook race",
      filePath: "src/webhook.ts",
      additions: 3,
      deletions: 1,
    },
  ],
  pullRequests: [
    {
      number: 456,
      title: "Fix webhook race",
      body: "Prevents duplicate event handling.",
      url: "https://github.com/example/repo/pull/456",
      state: "MERGED",
      mergedAt: "2024-03-02T12:00:00Z",
      comments: [
        {
          author: "Sarah",
          body: "Do not remove due race condition",
          createdAt: "2024-03-01T12:30:00Z",
        },
      ],
    },
  ],
  issues: [],
  lineContent: "if (event.id === previousId) return;",
};

const enabledConfig = ConfigSchema.parse({ provider: "ollama", enableLlm: true });
const defaultConfig = ConfigSchema.parse({});

const PROMPT_SNAPSHOT = `You are a code archaeologist. Given git history and GitHub metadata for a single line of code, write a 2–3 sentence "backstory" explaining WHY this line exists and what problem it solved.

Rules:
- Cite the commit SHA (short form) and PR number if available.
- Quote at most one short snippet from a PR/issue comment, in quotes.
- If evidence is thin or contradictory, say "Evidence is thin — likely [best guess]" instead of fabricating.
- Never invent commit messages, PR numbers, authors, or quotes. Only use provided data.
- Write in plain English for a developer joining the team. No fluff.
- Max 80 words.

Data:
<COMMITS>[]</COMMITS>
<PRS>[]</PRS>
<ISSUES>[]</ISSUES>
<LINE_CONTENT>""</LINE_CONTENT>`;

function stubOllama(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: { content } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  graphqlRequest.mockReset();
  graphqlDefaults.mockReturnValue(graphqlRequest);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LLM prompt and evidence guardrails", () => {
  it("matches the system prompt snapshot", () => {
    expect(buildPrompt(emptyStory, defaultConfig)).toBe(PROMPT_SNAPSHOT);
  });

  it("returns the thin-evidence fallback without making a request for empty evidence", async () => {
    const fetchMock = stubOllama("A fabricated but plausible story.");
    await expect(summarize(emptyStory, enabledConfig)).resolves.toContain("Evidence is thin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the thin-evidence fallback when LLM sending is disabled", async () => {
    const fetchMock = stubOllama("This response must not be used.");
    await expect(summarize(story, defaultConfig)).resolves.toContain("Evidence is thin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the thin-evidence fallback when the configured token budget cannot fit the prompt", async () => {
    const fetchMock = stubOllama("This response must not be used.");
    const smallBudget = ConfigSchema.parse({ enableLlm: true, tokenBudget: 1 });
    await expect(summarize(story, smallBudget)).resolves.toContain("Evidence is thin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a grounded LLM response", async () => {
    const fetchMock = stubOllama(
      'Commit a1b2c3d fixed the webhook race in PR #456. The comment says "Do not remove due race condition".',
    );
    await expect(summarize(story, enabledConfig)).resolves.toContain("a1b2c3d");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("replaces an ungrounded LLM response with the thin-evidence fallback", async () => {
    stubOllama("PR #999 fixed the race.");
    await expect(summarize(story, enabledConfig)).resolves.toContain("Evidence is thin");
  });

  it("truncates a long response to complete sentences within 80 words", async () => {
    const fetchMock = stubOllama(
      `Commit a1b2c3d fixed the race. ${Array.from({ length: 76 }, () => "detail").join(" ")} in PR #456; comment: "Do not remove due race condition".`,
    );
    const result = await summarize(story, enabledConfig);
    expect(result).toBe("Commit a1b2c3d fixed the race.");
    expect(validateStory(result, story).ok).toBe(true);
    expect(result.split(/\s+/)).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back if truncation keeps an ungrounded first sentence", async () => {
    const fetchMock = stubOllama(
      `Commit deadc0de fixed the race. ${Array.from({ length: 76 }, () => "detail").join(" ")} in PR #456; comment: "Do not remove due race condition".`,
    );
    await expect(summarize(story, enabledConfig)).resolves.toContain("Evidence is thin");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("logs only the safe error class in debug mode", async () => {
    const secret = "provider-error-sensitive-token";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(secret));
    vi.stubGlobal("fetch", fetchMock);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const debugConfig = ConfigSchema.parse({ enableLlm: true, debug: true });

    const caught = await summarize(story, debugConfig).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("Expected summarize to reject with an Error.");
    }
    expect(caught.message).not.toContain(secret);
    expect(caught.stack).not.toContain(secret);
    const debugOutput = debug.mock.calls.flat().join(" ");
    expect(debugOutput).toContain("TypeError");
    expect(debugOutput).not.toContain(secret);
  });
});

describe("GitHub enrichment guardrails", () => {
  it("throws the SHA validation error before attempting a request", async () => {
    await expect(
      enrichCommit("not-a-sha", {
        githubToken: "test-token",
        requestTimeoutMs: 30_000,
        repository: { owner: "example", name: "repo" },
      }),
    ).rejects.toThrow();
    expect(graphqlDefaults).not.toHaveBeenCalled();
  });

  it("redacts the final error after exhausting GitHub rate-limit retries", async () => {
    const token = "test-token";
    const rateLimitError = Object.assign(new Error("rate limit; token should be redacted"), {
      status: 429,
    });
    graphqlRequest.mockRejectedValue(rateLimitError);
    vi.useFakeTimers();

    const request = enrichCommit("a1b2c3d4e5f6789012345678901234567890abcd", {
      githubToken: token,
      requestTimeoutMs: 30_000,
      repository: { owner: "example", name: "repo" },
    });
    const caught = request.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("Expected enrichCommit to reject with an Error.");
    }
    expect(error.message).toBe("GitHub enrichment failed; details redacted.");
    expect(error.message).not.toContain(token);

    expect(graphqlDefaults).toHaveBeenCalledTimes(1);
    expect(graphqlRequest).toHaveBeenCalledTimes(4);
  }, 5_000);
});

describe("validateStory grounding checks", () => {
  it("accepts a summary with supported evidence", () => {
    expect(
      validateStory("Commit a1b2c3d fixed this in PR #456.", story),
    ).toEqual({ ok: true });
  });

  it("rejects unsupported citations in a summary", () => {
    const result = validateStory("Commit deadc0de fixed this in PR #999.", story);
    expect(result).toMatchObject({ ok: false });
  });
});
