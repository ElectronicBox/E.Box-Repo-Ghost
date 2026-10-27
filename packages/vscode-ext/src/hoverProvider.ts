import * as vscode from "vscode";
import {
  createStoryCache,
  enrichCommit,
  getFileHistory,
  getLineBlame,
  summarize,
  type Config,
  type LineStory,
  type StoryCache,
} from "@repo-ghost/core";
import type { RepoGhostOutput } from "./outputChannel.js";

export interface HoverProviderOptions {
  getConfig: () => Config;
  getCache?: (repositoryRoot: string, ttlMs: number) => StoryCache;
}

export function createHoverProvider(
  output: RepoGhostOutput,
  options: HoverProviderOptions,
): vscode.HoverProvider {
  const caches = new Map<string, StoryCache>();
  const cacheFor = options.getCache ?? ((repositoryRoot, ttlMs) => {
    const key = `${repositoryRoot}\0${ttlMs}`;
    const existing = caches.get(key);
    if (existing !== undefined) return existing;
    const cache = createStoryCache(repositoryRoot, ttlMs);
    caches.set(key, cache);
    return cache;
  });

  function failureHover(message: string): vscode.Hover {
    const markdown = new vscode.MarkdownString(`_${message}_`);
    markdown.isTrusted = false;
    return new vscode.Hover(markdown);
  }

  function renderStory(story: LineStory, cached: boolean): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    if (cached) markdown.appendMarkdown("⚡ cached\n\n");
    markdown.appendMarkdown(`**${story.backstory}**\n\n`);
    markdown.appendMarkdown(`Commit: \`${story.commit.sha.slice(0, 12)}\`\n\n`);
    markdown.appendMarkdown(`Author: ${story.commit.authorName}`);
    return new vscode.Hover(markdown);
  }

  return {
    async provideHover(document, position) {
      const line = position.line + 1;
      try {
        const blame = await getLineBlame(document.uri.fsPath, line);
        if (blame === null) return undefined;

        const config = options.getConfig();
        if (!config.enableLlm) {
          const hint = new vscode.MarkdownString(
            "_Enable a provider with `Repo Ghost: Enable Provider` for LLM summaries._",
          );
          hint.isTrusted = false;
          return new vscode.Hover(hint);
        }
        const cache = cacheFor(blame.repositoryRoot, config.cacheTtlMs);
        const cached = await cache.get(document.uri.fsPath, blame.lineContent, blame.headSha);
        if (cached !== undefined) return renderStory(cached, true);

        const commits = [];
        for await (const commit of getFileHistory(document.uri.fsPath)) {
          commits.push(commit);
          if (commits.length >= 20) break;
        }
        const enrichment =
          config.enableGitHubEnrichment && config.githubToken
            ? await enrichCommit(blame.commit.sha, {
                githubToken: config.githubToken,
                requestTimeoutMs: config.requestTimeoutMs,
              })
            : { pullRequests: [], issues: [] };
        const story = {
          filePath: document.uri.fsPath,
          line,
          lineContent: blame.lineContent,
          commit: blame.commit,
          commits,
          pullRequests: enrichment.pullRequests,
          issues: enrichment.issues,
        };
        const backstory = await summarize(story, config);
        const lineStory: LineStory = {
          ...story,
          backstory,
          cached: false,
        };
        await cache.set(document.uri.fsPath, blame.lineContent, blame.headSha, lineStory);
        return renderStory(lineStory, false);
      } catch (error) {
        const provider = options.getConfig().provider;
        const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
        output.warn(`Unable to load line story; ${provider} provider request failed (${errorClass}).`);
        return failureHover(
          `Repo Ghost could not reach the ${provider} provider. Check its configuration and availability.`,
        );
      }
    },
  };
}
