import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { simpleGit, type SimpleGit } from "simple-git";
import { z } from "zod";
import { RiskEntrySchema, type RiskEntry } from "./types.js";

const RECORD_SEPARATOR = "\x1e";
const GitLogRecordSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  authorName: z.string(),
  authorEmail: z.string(),
  message: z.string(),
});

export interface GitLogRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  message: string;
}

export interface FileMetrics {
  authors: Set<string>;
  commits: Set<string>;
  churn: number;
  revertCommits: Set<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseGitLogRecord(line: string): GitLogRecord {
  if (!line.startsWith(RECORD_SEPARATOR)) {
    throw new Error("Unexpected git log record; missing record separator.");
  }
  const fields = line.slice(1).split("\0");
  if (fields.length !== 4) {
    throw new Error("Unexpected git log record; could not parse commit metadata.");
  }
  const [sha, authorName, authorEmail, message] = fields;
  return GitLogRecordSchema.parse({ sha, authorName, authorEmail, message });
}

export function addFileChange(
  files: Map<string, FileMetrics>,
  record: GitLogRecord,
  numstat: string,
): void {
  const fields = numstat.split("\t");
  if (fields.length < 3) {
    console.warn("repo-ghost: skipping malformed risk-map numstat record.");
    return;
  }
  const [added, deleted, ...pathParts] = fields;
  const filePath = pathParts.join("\t").replaceAll("\\", "/");
  if (!filePath || added === undefined || deleted === undefined) {
    console.warn("repo-ghost: skipping malformed risk-map numstat record.");
    return;
  }

  if (!/^(?:\d+|[-])$/.test(added) || !/^(?:\d+|[-])$/.test(deleted)) {
    console.warn("repo-ghost: skipping malformed risk-map numstat record.");
    return;
  }
  const additions = added === "-" ? 0 : Number(added);
  const deletions = deleted === "-" ? 0 : Number(deleted);
  let metrics = files.get(filePath);
  if (metrics === undefined) {
    metrics = {
      authors: new Set(),
      commits: new Set(),
      churn: 0,
      revertCommits: new Set(),
    };
    files.set(filePath, metrics);
  }
  metrics.authors.add(record.authorEmail || record.authorName);
  metrics.commits.add(record.sha);
  metrics.churn += additions + deletions;
  // Counts revert commits that touch this file, not reverts of changes to this file.
  if (/^Revert\b/i.test(record.message)) metrics.revertCommits.add(record.sha);
}

async function warnIfShallowClone(git: SimpleGit): Promise<void> {
  const gitDirectory = await git.revparse(["--absolute-git-dir"]);
  try {
    await access(resolve(gitDirectory, "shallow"));
    console.warn("repo-ghost: this is a shallow clone; risk-map history may be incomplete.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/** Returns per-file risk entries limited to the requested directory within its repository. */
export async function getRiskMap(directory: string): Promise<RiskEntry[]> {
  const absolutePath = isAbsolute(directory) ? resolve(directory) : resolve(process.cwd(), directory);
  const discoveryGit = simpleGit(absolutePath);
  let repositoryRoot: string;
  try {
    repositoryRoot = resolve(await discoveryGit.revparse(["--show-toplevel"]));
  } catch (error) {
    throw new Error(
      `Cannot build a risk map for "${absolutePath}": not inside a git repository.`,
      { cause: error },
    );
  }
  const relativePath = relative(repositoryRoot, absolutePath).replaceAll("\\", "/") || ".";
  const git = simpleGit(repositoryRoot);
  await warnIfShallowClone(git);

  const child = spawn(
    "git",
    [
      "log",
      // --first-parent counts merge commits once on the selected branch's history.
      "--first-parent",
      "--numstat",
      "--format=tformat:%x1e%H%x00%an%x00%ae%x00%s",
      "--",
      relativePath,
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: Buffer[] = [];
  let childClosed = false;
  let stdoutError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdout.on("error", (error) => {
    if (!("code" in error && error.code === "EPIPE")) stdoutError = error;
  });
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      childClosed = true;
      if (code === 0) {
        resolveExit();
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectExit(
          new Error(`git log for risk map failed${detail ? `: ${detail}` : ` (exit ${code})`}`),
        );
      }
    });
  });
  void exit.catch(() => undefined);

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const files = new Map<string, FileMetrics>();
  let currentRecord: GitLogRecord | undefined;
  try {
    for await (const line of lines) {
      if (line.startsWith(RECORD_SEPARATOR)) {
        try {
          currentRecord = parseGitLogRecord(line);
        } catch (error) {
          currentRecord = undefined;
          console.warn(`repo-ghost: skipping malformed risk-map commit: ${errorMessage(error)}`);
        }
      } else if (currentRecord !== undefined && line.length > 0) {
        addFileChange(files, currentRecord, line);
      }
    }
    if (stdoutError !== undefined) throw stdoutError;
    await exit;
  } finally {
    lines.close();
    child.stdout.destroy();
    if (!childClosed) {
      child.kill();
      await exit.catch(() => undefined);
    }
  }

  let maxCommitCount = 0;
  let maxAuthorCount = 0;
  let maxRevertCount = 0;
  let maxChurn = 0;
  for (const metrics of files.values()) {
    maxCommitCount = Math.max(maxCommitCount, metrics.commits.size);
    maxAuthorCount = Math.max(maxAuthorCount, metrics.authors.size);
    maxRevertCount = Math.max(maxRevertCount, metrics.revertCommits.size);
    maxChurn = Math.max(maxChurn, metrics.churn);
  }

  return [...files.entries()]
    .map(([filePath, metrics]) => {
      // Risk is a 0–100 weighted score: commit count 30%, author diversity 20%,
      // reverts 25%, and churn 25%; each signal is normalized to the repo maximum.
      const riskScore =
        (maxCommitCount === 0 ? 0 : (metrics.commits.size / maxCommitCount) * 30) +
        (maxAuthorCount === 0 ? 0 : (metrics.authors.size / maxAuthorCount) * 20) +
        (maxRevertCount === 0 ? 0 : (metrics.revertCommits.size / maxRevertCount) * 25) +
        (maxChurn === 0 ? 0 : (metrics.churn / maxChurn) * 25);
      return RiskEntrySchema.parse({
        filePath,
        commitCount: metrics.commits.size,
        distinctAuthors: metrics.authors.size,
        revertCount: metrics.revertCommits.size,
        churn: metrics.churn,
        riskScore,
      });
    })
    .sort(
      (left, right) =>
        right.riskScore - left.riskScore || left.filePath.localeCompare(right.filePath),
    );
}
