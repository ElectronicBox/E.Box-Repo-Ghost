import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import { getFileHistory, getLineBlame } from "./git.js";

const roots: string[] = [];

async function createRepository(): Promise<{ root: string; git: ReturnType<typeof simpleGit> }> {
  const root = await mkdtemp(join(tmpdir(), "repo-ghost-git-"));
  roots.push(root);
  const git = simpleGit(root);
  await git.init(["-b", "main"]);
  await git.addConfig("user.name", "Test User");
  await git.addConfig("user.email", "test@example.test");
  return { root, git };
}

async function collectHistory(filePath: string): Promise<unknown[]> {
  const commits: unknown[] = [];
  for await (const commit of getFileHistory(filePath)) commits.push(commit);
  return commits;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("git history edge cases", () => {
  it("skips binary files for history and blame", async () => {
    const { root, git } = await createRepository();
    const filePath = join(root, "image.bin");
    await writeFile(filePath, Buffer.from([0, 1, 2, 3]));
    await git.add("image.bin");
    await git.commit("Add binary file");

    await expect(collectHistory(filePath)).resolves.toEqual([]);
    await expect(getLineBlame(filePath, 1)).resolves.toBeNull();
  });

  it("warns but continues for a shallow clone", async () => {
    const { root, git } = await createRepository();
    await writeFile(join(root, "file.txt"), "one\n", "utf8");
    await git.add("file.txt");
    await git.commit("Add file");
    const gitDirectory = await git.revparse(["--absolute-git-dir"]);
    const head = await git.revparse(["HEAD"]);
    await writeFile(join(gitDirectory, "shallow"), `${head.trim()}\n`, "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(collectHistory(join(root, "file.txt"))).resolves.toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      "repo-ghost: this is a shallow clone; file history may be incomplete.",
    );
  });

});
