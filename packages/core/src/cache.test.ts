import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCacheKey, createStoryCache } from "./cache.js";
import type { LineStory } from "./types.js";

const story: LineStory = {
  filePath: "src/webhook.ts",
  line: 12,
  lineContent: "if (event.id === previousId) return;",
  commit: {
    sha: "a1b2c3d4e5f6789012345678901234567890abcd",
    authorName: "Sarah",
    authorEmail: "sarah@example.test",
    authoredAt: "2024-03-01T12:00:00Z",
    message: "Fix webhook race",
    filePath: "src/webhook.ts",
    additions: 3,
    deletions: 1,
  },
  pullRequests: [],
  issues: [],
  backstory: "Commit a1b2c3d fixed the webhook race.",
  cached: false,
};

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-ghost-cache-"));
  tempRoots.push(root);
  return root;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createStoryCache", () => {
  it("builds keys from path, line content, and HEAD SHA", () => {
    const original = createCacheKey("src/a.ts", "one", "head-a");
    expect(createCacheKey("src/a.ts", "two", "head-a")).not.toBe(original);
    expect(createCacheKey("src/a.ts", "one", "head-b")).not.toBe(original);
    expect(createCacheKey("src/b.ts", "one", "head-a")).not.toBe(original);
  });

  it("persists stories and marks cache hits", async () => {
    const root = await createRoot();
    const cache = createStoryCache(root, 60_000);
    await cache.set(story.filePath, story.lineContent, "head-a", story);

    const reopened = createStoryCache(root, 60_000);
    await expect(reopened.get(story.filePath, story.lineContent, "head-a")).resolves.toMatchObject({
      ...story,
      cached: true,
    });
  });

  it("retains entries from earlier HEADs because HEAD is part of the key", async () => {
    const root = await createRoot();
    const cache = createStoryCache(root, 60_000);
    await cache.set(story.filePath, story.lineContent, "head-a", story);
    await cache.set(story.filePath, story.lineContent, "head-b", story);

    const reopened = createStoryCache(root, 60_000);
    await expect(reopened.get(story.filePath, story.lineContent, "head-a")).resolves.toMatchObject({
      cached: true,
    });
    await expect(reopened.get(story.filePath, story.lineContent, "head-b")).resolves.toMatchObject({
      cached: true,
    });
  });

  it("supports an explicit hard reset", async () => {
    const cache = createStoryCache(await createRoot(), 60_000);
    await cache.set(story.filePath, story.lineContent, "head-a", story);
    await cache.invalidateOnHeadChange("head-b");

    await expect(cache.get(story.filePath, story.lineContent, "head-a")).resolves.toBeUndefined();
  });

  it("returns a miss for expired entries", async () => {
    vi.useFakeTimers();
    const cache = createStoryCache(await createRoot(), 1_000);
    await cache.set(story.filePath, story.lineContent, "head-a", story);
    vi.advanceTimersByTime(999);

    await expect(cache.get(story.filePath, story.lineContent, "head-a")).resolves.toMatchObject({
      cached: true,
    });
    vi.advanceTimersByTime(1);

    await expect(cache.get(story.filePath, story.lineContent, "head-a")).resolves.toBeUndefined();
  });

  it("merges entries from cache instances with stale in-memory state", async () => {
    const root = await createRoot();
    const first = createStoryCache(root, 60_000);
    const second = createStoryCache(root, 60_000);
    // Both instances load the same empty file before either one writes.
    await first.get("src/first.ts", "first line", "head-a");
    await second.get("src/second.ts", "second line", "head-a");

    await first.set("src/first.ts", "first line", "head-a", story);
    await second.set("src/second.ts", "second line", "head-a", {
      ...story,
      filePath: "src/second.ts",
      lineContent: "second line",
    });

    const onDisk = z
      .object({ entries: z.record(z.unknown()) })
      .parse(JSON.parse(await readFile(join(root, ".repo-ghost", "cache.json"), "utf8")));
    expect(Object.keys(onDisk.entries)).toContain(
      createCacheKey("src/first.ts", "first line", "head-a"),
    );
    expect(Object.keys(onDisk.entries)).toContain(
      createCacheKey("src/second.ts", "second line", "head-a"),
    );

    const reopened = createStoryCache(root, 60_000);
    await expect(reopened.get("src/first.ts", "first line", "head-a")).resolves.toMatchObject({
      cached: true,
    });
    await expect(reopened.get("src/second.ts", "second line", "head-a")).resolves.toMatchObject({
      cached: true,
    });
  });

  it("prunes expired entries on the next persistence", async () => {
    vi.useFakeTimers();
    const root = await createRoot();
    const cache = createStoryCache(root, 1_000);
    await cache.set("src/first.ts", "first line", "head-a", story);
    vi.advanceTimersByTime(1_000);
    await cache.set("src/second.ts", "second line", "head-a", {
      ...story,
      filePath: "src/second.ts",
      lineContent: "second line",
    });

    const reopened = createStoryCache(root, 1_000);
    await expect(reopened.get("src/first.ts", "first line", "head-a")).resolves.toBeUndefined();
    await expect(reopened.get("src/second.ts", "second line", "head-a")).resolves.toMatchObject({
      cached: true,
    });
    const persisted = z
      .object({ entries: z.record(z.unknown()) })
      .parse(JSON.parse(await readFile(join(root, ".repo-ghost", "cache.json"), "utf8")));
    expect(Object.keys(persisted.entries)).not.toContain(
      createCacheKey("src/first.ts", "first line", "head-a"),
    );
  });

  it("recovers from a corrupt cache file and overwrites it on the next set", async () => {
    const root = await createRoot();
    const directory = join(root, ".repo-ghost");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "cache.json"), "{ definitely not JSON", "utf8");

    const cache = createStoryCache(root, 60_000);
    await expect(cache.get(story.filePath, story.lineContent, "head-a")).resolves.toBeUndefined();
    await cache.set(story.filePath, story.lineContent, "head-a", story);

    const persisted = z
      .object({ entries: z.record(z.unknown()), version: z.number() })
      .parse(JSON.parse(await readFile(join(directory, "cache.json"), "utf8")));
    expect(persisted.version).toBe(1);
    expect(persisted.entries[createCacheKey(story.filePath, story.lineContent, "head-a")]).toBeDefined();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("does not persist a token-like canary that is not part of the story", async () => {
    const root = await createRoot();
    const cache = createStoryCache(root, 60_000);
    const canary = "ghp_repo_ghost_cache_canary_1234567890";
    await cache.set(story.filePath, story.lineContent, "head-a", story);

    const cacheText = await readFile(join(root, ".repo-ghost", "cache.json"), "utf8");
    expect(cacheText).not.toContain(canary);
  });

  it("redacts token-like content from persisted story fields", async () => {
    const root = await createRoot();
    const cache = createStoryCache(root, 60_000);
    const canary = "ghp_123456789012345678901234567890123456";
    await cache.set(story.filePath, story.lineContent, "head-a", {
      ...story,
      backstory: `Keep this explanation ${canary}.`,
      pullRequests: [{
        number: 1,
        title: `Title ${canary}`,
        body: `Body ${canary}`,
        url: "https://github.com/example/repo/pull/1",
        state: "OPEN",
        mergedAt: null,
        comments: [],
      }],
    });

    const cacheText = await readFile(join(root, ".repo-ghost", "cache.json"), "utf8");
    expect(cacheText).not.toContain(canary);
    expect(cacheText).toContain("Keep this explanation [REDACTED].");
    expect(cacheText).toContain("Title [REDACTED]");
    expect(cacheText).toContain("Body [REDACTED]");
  });
});
