import { spawn } from "node:child_process";
import { access, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { simpleGit, type SimpleGit } from "simple-git";
import { CommitInfoSchema, type CommitInfo } from "./types.js";

const RECORD_SEPARATOR = "\x1e";
const BINARY_SAMPLE_SIZE = 8 * 1024;

export interface LineBlame {
  commit: CommitInfo;
  lineContent: string;
}

export interface ChurnStats {
  additions: number;
  deletions: number;
  total: number;
}

interface FileContext {
  absolutePath: string;
  git: SimpleGit;
  relativePath: string;
  repositoryRoot: string;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getFileContext(filePath: string): Promise<FileContext> {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
  const git = simpleGit(resolve(absolutePath, ".."));
  let repositoryRoot: string;
  try {
    repositoryRoot = resolve(await git.revparse(["--show-toplevel"]));
  } catch (error) {
    throw new Error(
      `Cannot inspect "${absolutePath}": not inside a git repository, or git could not resolve its root.`,
      { cause: error },
    );
  }
  const relativePath = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");

  return { absolutePath, git, relativePath, repositoryRoot };
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r");
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_SIZE);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

async function warnIfShallowClone(context: FileContext): Promise<void> {
  const gitDirectory = await context.git.revparse(["--absolute-git-dir"]);
  const shallowFile = resolve(gitDirectory, "shallow");
  try {
    await access(shallowFile);
    console.warn("repo-ghost: this is a shallow clone; file history may be incomplete.");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function parseHistoryRecord(record: string, filePath: string): CommitInfo {
  const header = record.split("\n", 1)[0] ?? record;
  const fields = header.split("\0");
  if (fields.length !== 5) {
    throw new Error("Unexpected git log record; could not parse commit metadata.");
  }

  const [sha, authorName, authorEmail, authoredAt, message] = fields;
  if (
    sha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authoredAt === undefined ||
    message === undefined
  ) {
    throw new Error("Unexpected git log record; commit metadata is incomplete.");
  }

  return CommitInfoSchema.parse({
    sha,
    authorName,
    authorEmail,
    authoredAt,
    message,
    filePath,
    additions: 0,
    deletions: 0,
  });
}

function parseHistoryRecordOrWarn(record: string, filePath: string): CommitInfo | undefined {
  try {
    return parseHistoryRecord(record, filePath);
  } catch (error) {
    console.warn(
      `repo-ghost: skipping malformed history record for "${filePath}": ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * Streams file history so large repositories do not require buffering all git log output.
 */
export async function* getFileHistory(filePath: string): AsyncGenerator<CommitInfo> {
  const context = await getFileContext(filePath);
  if (await isBinaryFile(context.absolutePath)) {
    console.warn(`repo-ghost: skipping binary file "${filePath}".`);
    return;
  }
  await warnIfShallowClone(context);

  const child = spawn(
    "git",
    [
      "log",
      "--follow",
      "--format=tformat:%x1e%H%x00%an%x00%ae%x00%aI%x00%s",
      "--",
      context.relativePath,
    ],
    { cwd: context.repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: Buffer[] = [];
  let childClosed = false;
  let stdoutError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdout.on("error", (error) => {
    if (!("code" in error && error.code === "EPIPE")) {
      stdoutError = error;
    }
  });
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      childClosed = true;
      if (code === 0) {
        resolveExit();
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectExit(new Error(`git log failed${detail ? `: ${detail}` : ` (exit ${code})`}`));
      }
    });
  });
  void exit.catch(() => undefined);

  const decoder = new StringDecoder("utf8");
  let buffered = "";
  try {
    for await (const chunk of child.stdout) {
      buffered += decoder.write(chunk);
      let separator = buffered.indexOf(RECORD_SEPARATOR);
      if (separator === -1) continue;
      buffered = buffered.slice(separator);

      while ((separator = buffered.indexOf(RECORD_SEPARATOR, 1)) !== -1) {
        const record = buffered.slice(1, separator);
        if (record.length > 0) {
          const commit = parseHistoryRecordOrWarn(record, context.relativePath);
          if (commit !== undefined) yield commit;
        }
        buffered = buffered.slice(separator);
      }
    }

    buffered += decoder.end();
    const finalRecord = buffered.startsWith(RECORD_SEPARATOR) ? buffered.slice(1) : "";
    if (finalRecord.length > 0) {
      const commit = parseHistoryRecordOrWarn(finalRecord, context.relativePath);
      if (commit !== undefined) yield commit;
    }
    if (stdoutError !== undefined) throw stdoutError;
    await exit;
  } finally {
    child.stdout.destroy();
    if (!childClosed) {
      child.kill();
      await exit.catch(() => undefined);
    }
  }
}

export async function getLineBlame(filePath: string, line: number): Promise<LineBlame | null> {
  if (!Number.isInteger(line) || line < 1) {
    console.warn(`repo-ghost: cannot blame invalid line ${line} in "${filePath}".`);
    return null;
  }

  const context = await getFileContext(filePath);
  try {
    if (await isBinaryFile(context.absolutePath)) {
      console.warn(`repo-ghost: skipping blame for binary file "${filePath}".`);
      return null;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      console.warn(`repo-ghost: cannot blame missing or untracked file "${filePath}".`);
      return null;
    }
    throw error;
  }
  await warnIfShallowClone(context);

  try {
    const output = await context.git.raw([
      "blame",
      "--line-porcelain",
      "-L",
      `${line},${line}`,
      "--",
      context.relativePath,
    ]);
    const lines = output.split(/\r?\n/);
    const header = lines[0]?.match(/^([0-9a-f]{7,64})\s+\d+\s+\d+/i);
    if (!header?.[1]) {
      throw new Error("Could not parse git blame header.");
    }

    const valueFor = (key: string): string => {
      const prefix = `${key} `;
      const value = lines.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
      if (value === undefined) {
        throw new Error(`git blame output is missing ${key}.`);
      }
      return value;
    };
    const authorEmail = valueFor("author-mail").replace(/^<|>$/g, "");
    const authorTime = Number(valueFor("author-time"));
    if (!Number.isFinite(authorTime)) {
      throw new Error("git blame returned an invalid author timestamp.");
    }
    const sourceLine = lines.find((entry) => entry.startsWith("\t"));
    if (sourceLine === undefined) {
      throw new Error("git blame output is missing source text.");
    }

    return {
      commit: CommitInfoSchema.parse({
        sha: header[1],
        authorName: valueFor("author"),
        authorEmail,
        authoredAt: new Date(authorTime * 1_000).toISOString(),
        message: valueFor("summary"),
        filePath: context.relativePath,
        additions: 0,
        deletions: 0,
      }),
      lineContent: sourceLine.slice(1),
    };
  } catch (error) {
    console.warn(`repo-ghost: git blame unavailable for "${filePath}:${line}": ${errorMessage(error)}`);
    return null;
  }
}

// TODO(risk-map): batch churn queries per repository; do not call this per file.
export async function getChurnStats(filePath: string): Promise<ChurnStats> {
  const context = await getFileContext(filePath);
  if (await isBinaryFile(context.absolutePath)) {
    console.warn(`repo-ghost: skipping churn stats for binary file "${filePath}".`);
    return { additions: 0, deletions: 0, total: 0 };
  }
  await warnIfShallowClone(context);

  const child = spawn(
    "git",
    ["log", "--numstat", "--format=", "--", context.relativePath],
    { cwd: context.repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: Buffer[] = [];
  let childClosed = false;
  let stdoutError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdout.on("error", (error) => {
    if (!("code" in error && error.code === "EPIPE")) {
      stdoutError = error;
    }
  });
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      childClosed = true;
      if (code === 0) {
        resolveExit();
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectExit(new Error(`git log --numstat failed${detail ? `: ${detail}` : ` (exit ${code})`}`));
      }
    });
  });
  void exit.catch(() => undefined);

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let additions = 0;
  let deletions = 0;
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      const fields = line.split("\t");
      if (fields.length < 3) {
        console.warn(`repo-ghost: skipping malformed numstat record for "${filePath}".`);
        continue;
      }
      const added = fields[0];
      const deleted = fields[1];
      if (added !== undefined && /^\d+$/.test(added)) additions += Number(added);
      if (deleted !== undefined && /^\d+$/.test(deleted)) deletions += Number(deleted);
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

  return { additions, deletions, total: additions + deletions };
}
