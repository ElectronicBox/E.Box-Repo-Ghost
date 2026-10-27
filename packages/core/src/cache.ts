import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LineStorySchema, type LineStory } from "./types.js";

const CacheEntrySchema = z.object({
  cachedAt: z.number().int().nonnegative(),
  story: LineStorySchema,
});

const CacheFileSchema = z.object({
  version: z.literal(1),
  headSha: z.string().nullable(),
  entries: z.record(z.string().regex(/^[0-9a-f]{64}$/), CacheEntrySchema),
});

type CacheFile = z.infer<typeof CacheFileSchema>;

export interface StoryCache {
  get(filePath: string, lineContent: string, headSha: string): Promise<LineStory | undefined>;
  set(filePath: string, lineContent: string, headSha: string, story: LineStory): Promise<void>;
  clear(): Promise<void>;
  invalidateOnHeadChange(headSha: string): Promise<void>;
}

function emptyCache(headSha: string | null = null): CacheFile {
  return { version: 1, headSha, entries: {} };
}

export function createCacheKey(filePath: string, lineContent: string, headSha: string): string {
  const lineHash = createHash("sha256").update(lineContent).digest("hex");
  return createHash("sha256")
    .update(`${filePath}\0${lineHash}\0${headSha}`)
    .digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isCorruptCacheError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof z.ZodError;
}

export function createStoryCache(repositoryRoot: string, ttlMs: number): StoryCache {
  const validatedTtlMs = z.number().int().positive().parse(ttlMs);
  const directory = resolve(repositoryRoot, ".repo-ghost");
  const cachePath = join(directory, "cache.json");
  let state: CacheFile | undefined;
  let loadPromise: Promise<CacheFile> | undefined;
  let writeQueue: Promise<void> = Promise.resolve();
  let warnedAboutCorruptCache = false;

  function warnAboutCorruptCache(): void {
    if (warnedAboutCorruptCache) return;
    warnedAboutCorruptCache = true;
    console.warn("repo-ghost: cache.json is invalid; starting with an empty cache.");
  }

  async function readCacheFile(): Promise<CacheFile> {
    let content: string;
    try {
      content = await readFile(cachePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return emptyCache();
      throw error;
    }

    try {
      return CacheFileSchema.parse(JSON.parse(content));
    } catch (error) {
      if (isCorruptCacheError(error)) {
        warnAboutCorruptCache();
        return emptyCache();
      }
      throw error;
    }
  }

  async function loadState(): Promise<CacheFile> {
    if (state !== undefined) return state;
    if (loadPromise === undefined) {
      loadPromise = readCacheFile().then(
        (loaded) => {
          state = loaded;
          return loaded;
        },
        (error: unknown) => {
          loadPromise = undefined;
          throw error;
        },
      );
    }
    return loadPromise;
  }

  async function persist(hardReset = false): Promise<void> {
    const current = await loadState();
    const write = writeQueue.then(async () => {
      const diskCache = hardReset ? emptyCache(current.headSha) : await readCacheFile();
      const mergedEntries: CacheFile["entries"] = { ...diskCache.entries };
      const now = Date.now();

      for (const [key, entry] of Object.entries(current.entries)) {
        if (now - entry.cachedAt >= validatedTtlMs) continue;
        const diskEntry = mergedEntries[key];
        if (diskEntry === undefined || entry.cachedAt > diskEntry.cachedAt) {
          mergedEntries[key] = entry;
        }
      }
      for (const [key, entry] of Object.entries(mergedEntries)) {
        if (now - entry.cachedAt >= validatedTtlMs) {
          delete mergedEntries[key];
        }
      }

      const mergedCache = CacheFileSchema.parse({
        version: 1,
        headSha: current.headSha ?? diskCache.headSha,
        entries: mergedEntries,
      });
      state = mergedCache;

      const temporaryPath = join(directory, `.cache.${randomUUID()}.tmp`);
      const content = JSON.stringify(mergedCache, null, 2);
      // TODO(concurrency): add a lockfile for competing repo-ghost processes in v0.2.
      // TODO(durability): fsync before rename; corrupt files are tolerated on load.
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, cachePath);
    });
    writeQueue = write.catch(() => undefined);
    await write;
  }

  return {
    async get(filePath, lineContent, headSha) {
      const current = await loadState();
      const key = createCacheKey(filePath, lineContent, headSha);
      const entry = current.entries[key];
      if (entry === undefined) return undefined;
      if (Date.now() - entry.cachedAt >= validatedTtlMs) {
        delete current.entries[key];
        await persist();
        return undefined;
      }
      return LineStorySchema.parse({ ...entry.story, cached: true });
    },
    async set(filePath, lineContent, headSha, story) {
      const current = await loadState();
      current.headSha = headSha;
      const validatedStory = LineStorySchema.parse({ ...story, cached: false });
      current.entries[createCacheKey(filePath, lineContent, headSha)] = {
        cachedAt: Date.now(),
        story: validatedStory,
      };
      await persist();
    },
    async clear() {
      const current = await loadState();
      current.entries = {};
      await persist(true);
    },
    // Explicit hard reset: call only when the caller intentionally wants to drop all entries.
    async invalidateOnHeadChange(headSha) {
      const current = await loadState();
      current.headSha = headSha;
      current.entries = {};
      await persist(true);
    },
  };
}
