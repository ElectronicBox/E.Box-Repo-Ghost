import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  addFileChange,
  getRiskMap,
  parseGitLogRecord,
  type FileMetrics,
} from "./riskMap.js";

const tempRoots: string[] = [];

async function createRepository(): Promise<{ git: SimpleGit; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-ghost-risk-"));
  const git = simpleGit(root);
  try {
    await git.init(["-b", "main"]);
    await git.addConfig("user.name", "Alice");
    await git.addConfig("user.email", "alice@example.test");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "docs"));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  tempRoots.push(root);
  return { git, root };
}

async function commitFile(
  git: SimpleGit,
  filePath: string,
  authorName: string,
  authorEmail: string,
  message: string,
): Promise<void> {
  await git.addConfig("user.name", authorName);
  await git.addConfig("user.email", authorEmail);
  await git.add(filePath);
  await git.commit(message);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseGitLogRecord", () => {
  it("rejects a line that does not start with the record separator", () => {
    expect(() =>
      parseGitLogRecord(
        "a1b2c3d4e5f6789012345678901234567890abcd\0Alice\0alice@example.test\0subject",
      ),
    ).toThrow("missing record separator");
  });

  it("parses a record that starts with the record separator", () => {
    expect(
      parseGitLogRecord(
        "\x1ea1b2c3d4e5f6789012345678901234567890abcd\0Alice\0alice@example.test\0subject",
      ),
    ).toMatchObject({
      sha: "a1b2c3d4e5f6789012345678901234567890abcd",
      authorName: "Alice",
      authorEmail: "alice@example.test",
      message: "subject",
    });
  });

  it("counts a duplicate revert SHA only once per file", () => {
    const files = new Map<string, FileMetrics>();
    const record = {
      sha: "a1b2c3d4e5f6789012345678901234567890abcd",
      authorName: "Alice",
      authorEmail: "alice@example.test",
      message: "Revert #123",
    };

    addFileChange(files, record, "1\t0\tsrc/entry.ts");
    addFileChange(files, record, "1\t0\tsrc/entry.ts");

    expect(files.get("src/entry.ts")?.commits.size).toBe(1);
    expect(files.get("src/entry.ts")?.revertCommits.size).toBe(1);
  });

  it("warns and skips a malformed numstat line", () => {
    const files = new Map<string, FileMetrics>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const record = {
      sha: "a1b2c3d4e5f6789012345678901234567890abcd",
      authorName: "Alice",
      authorEmail: "alice@example.test",
      message: "Add source",
    };

    expect(() => addFileChange(files, record, "abc\tdef\tpath")).not.toThrow();
    expect(files.size).toBe(0);
    expect(warning).toHaveBeenCalledOnce();
  });
});

describe("getRiskMap", () => {
  it("rejects when the directory is not inside a git repository", async () => {
    await expect(getRiskMap(tmpdir())).rejects.toThrow("not inside a git repository");
  });

  it("computes per-directory metrics and recognizes both Revert subject forms", async () => {
    const { git, root } = await createRepository();
    const filePath = join(root, "src", "entry.ts");
    await writeFile(filePath, "one\n", "utf8");
    await commitFile(git, "src/entry.ts", "Alice", "alice@example.test", "Initial source");

    await writeFile(filePath, "one\ntwo\n", "utf8");
    await commitFile(
      git,
      "src/entry.ts",
      "Bob",
      "bob@example.test",
      'Revert "another commit"',
    );

    await writeFile(filePath, "one\ntwo\nthree\n", "utf8");
    await commitFile(git, "src/entry.ts", "Alice", "alice@example.test", "Revert #123");

    await writeFile(join(root, "docs", "notes.md"), "notes\n", "utf8");
    await commitFile(git, "docs/notes.md", "Alice", "alice@example.test", "Add docs");

    const riskEntries = await getRiskMap(join(root, "src"));
    expect(riskEntries).toHaveLength(1);
    expect(riskEntries[0]).toMatchObject({
      filePath: "src/entry.ts",
      commitCount: 3,
      distinctAuthors: 2,
      revertCount: 2,
      churn: 3,
    });
    expect(riskEntries[0]?.riskScore).toBeGreaterThan(0);
    expect(riskEntries[0]?.riskScore).toBeLessThanOrEqual(100);

    const repositoryEntries = await getRiskMap(root);
    expect(repositoryEntries.map((entry) => entry.filePath).sort()).toEqual([
      "docs/notes.md",
      "src/entry.ts",
    ]);
    const sourceRisk = repositoryEntries.find((entry) => entry.filePath === "src/entry.ts");
    const docsRisk = repositoryEntries.find((entry) => entry.filePath === "docs/notes.md");
    expect(sourceRisk?.riskScore).toBeGreaterThan(docsRisk?.riskScore ?? 0);
  });
});
