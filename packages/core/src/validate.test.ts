import { describe, expect, it } from "vitest";
import { validateStory } from "./validate.js";
import type { RawStory } from "./types.js";

const evidence: RawStory = {
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
          body: "Do not remove due race\ncondition",
          createdAt: "2024-03-01T12:30:00Z",
        },
      ],
    },
  ],
  issues: [
    {
      number: 432,
      title: "Duplicate webhook events",
      body: "Events are processed twice.",
      url: "https://github.com/example/repo/issues/432",
      state: "CLOSED",
      comments: [],
    },
  ],
  lineContent: "if (event.id === previousId) return;",
};

describe("validateStory", () => {
  it("accepts a grounded short SHA prefix", () => {
    expect(validateStory("Commit a1b2c3d fixes the race.", evidence)).toEqual({ ok: true });
  });

  it("recognizes a valid SHA in prose and in parentheses", () => {
    expect(
      validateStory("a1b2c3d appears in prose (a1b2c3d) and is supported.", evidence),
    ).toEqual({ ok: true });
  });

  it("rejects a fabricated SHA", () => {
    const result = validateStory("Commit deadc0de fixed the race.", evidence);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.violations).toContain(
        "Summary cites a commit SHA not present in the evidence.",
      );
    }
  });

  it("does not treat a three-character prefix as a SHA citation", () => {
    expect(validateStory("The change starts with a1b.", evidence)).toEqual({ ok: true });
  });

  it.each(["deadbeef", "cafebabe", "facefeed", "8badf00d"])(
    "allows the prose hex word %s without evidence",
    (word) => {
      expect(validateStory(`The sentinel is ${word}.`, evidence)).toEqual({ ok: true });
    },
  );

  it("accepts a PR and issue number present in evidence", () => {
    expect(validateStory("PR #456 addresses issue #432.", evidence)).toEqual({ ok: true });
  });

  it("rejects a fabricated PR or issue number", () => {
    const result = validateStory("PR #999 fixes the race.", evidence);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.violations).toContain(
        "Summary cites a PR or issue number not present in the evidence.",
      );
    }
  });

  it("accepts one exact comment quote", () => {
    expect(
      validateStory('The comment says "Do not remove due race condition".', evidence),
    ).toEqual({ ok: true });
  });

  it("rejects a paraphrased comment quote", () => {
    const result = validateStory('The comment says "keep it around for races".', evidence);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.violations).toContain(
        "Summary contains a quote not present in the provided comments.",
      );
    }
  });

  it("rejects more than one quoted snippet", () => {
    const result = validateStory(
      'The comments say "Do not remove due race condition" and "another quote".',
      evidence,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.violations).toContain(
        "Summary contains more than one quoted comment snippet.",
      );
    }
  });

  it("matches a quote after collapsing whitespace on both sides", () => {
    expect(
      validateStory('The comment says "Do not remove   due race condition".', evidence),
    ).toEqual({ ok: true });
  });

  it("rejects an empty summary", () => {
    expect(() => validateStory("   ", evidence)).toThrow();
  });
});
