#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPrompt,
  getFileHistory,
  getLineBlame,
  getRiskMap,
  summarize,
  type Config,
  type RawStory,
} from "@repo-ghost/core";

export const ENABLE_PROVIDER_MESSAGE =
  "LLM summaries are disabled. Run `Repo Ghost: Enable Provider` to enable a provider.";

interface CliOptions {
  json: boolean;
  dryRun: boolean;
}

export interface CliDependencies {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

function parseOptions(args: string[]): CliOptions {
  return {
    json: args.includes("--json"),
    dryRun: args.includes("--dry-run"),
  };
}

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function parseLocation(value: string): { filePath: string; line: number } {
  const separator = value.lastIndexOf(":");
  const filePath = separator === -1 ? value : value.slice(0, separator);
  const line = separator === -1 ? NaN : Number(value.slice(separator + 1));
  if (!filePath || !Number.isInteger(line) || line < 1) {
    throw new Error("Expected a location in the form <file>:<positive-line>.");
  }
  return { filePath, line };
}

function createConfig(enabled: boolean, env: NodeJS.ProcessEnv): Config {
  return {
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    apiKey: undefined,
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    enableLlm: enabled,
    enableGitHubEnrichment: Boolean(env.GITHUB_TOKEN),
    cacheTtlMs: 30 * 24 * 60 * 60 * 1_000,
    requestTimeoutMs: 30_000,
    tokenBudget: 1_800,
    debug: false,
  };
}

async function createStory(filePath: string, line: number): Promise<RawStory> {
  const blame = await getLineBlame(filePath, line);
  const commits = [];
  for await (const commit of getFileHistory(filePath)) {
    commits.push(commit);
    if (commits.length >= 20) break;
  }
  return {
    commits: blame === null ? commits : [blame.commit, ...commits.filter((commit) => commit.sha !== blame.commit.sha)],
    pullRequests: [],
    issues: [],
    lineContent: blame?.lineContent ?? (await readFile(resolve(filePath), "utf8")).split(/\r?\n/)[line - 1] ?? "",
  };
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const env = dependencies.env ?? process.env;
  const options = parseOptions(args);
  const command = args[0];

  try {
    if (command === "risk-map") {
      const directory = args[1];
      if (!directory) throw new Error("Expected a directory for risk-map.");
      const entries = await getRiskMap(directory);
      writeLine(stdout, options.json ? JSON.stringify(entries) : entries.map((entry) =>
        `${entry.riskScore.toFixed(1)}\t${entry.filePath}\t${entry.commitCount} commits`,
      ).join("\n"));
      return 0;
    }

    if (command !== "explain") {
      throw new Error("Usage: repo-ghost explain <file>:<line> [--json] [--dry-run]");
    }
    const location = parseLocation(args[1] ?? "");
    const story = await createStory(location.filePath, location.line);
    const enabled = env.REPO_GHOST_ENABLE_LLM === "1";
    if (!enabled) {
      if (options.json) writeLine(stdout, JSON.stringify({ enabled: false, message: ENABLE_PROVIDER_MESSAGE }));
      else writeLine(stdout, ENABLE_PROVIDER_MESSAGE);
      return 0;
    }

    const config = createConfig(enabled, env);
    const prompt = buildPrompt(story, config);
    if (options.dryRun) {
      writeLine(stdout, prompt);
      return 0;
    }
    const backstory = await summarize(story, config);
    writeLine(stdout, options.json ? JSON.stringify({ backstory }) : backstory);
    return 0;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "repo-ghost failed.");
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
