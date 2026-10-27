import { graphql } from "@octokit/graphql";
import pLimit from "p-limit";
import { simpleGit } from "simple-git";
import { z } from "zod";
import { IssueInfoSchema, PRInfoSchema, type IssueInfo, type PRInfo } from "./types.js";

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 500;
// TODO(testability): provide a resettable limiter for isolated rate-limit tests.
const requestLimit = pLimit(3);

const GitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);
const RepositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});
const CommentNodeSchema = z.object({
  author: z.object({ login: z.string() }).nullable().optional(),
  body: z.string(),
  createdAt: z.string(),
});
const CommentsConnectionSchema = z.object({
  nodes: z.array(CommentNodeSchema.nullable()).nullable(),
});
const IssueNodeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED"]),
  comments: CommentsConnectionSchema,
});
const PullRequestNodeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().nullable(),
  comments: CommentsConnectionSchema,
  closingIssuesReferences: z.object({
    nodes: z.array(IssueNodeSchema.nullable()).nullable(),
  }),
});
const EnrichmentResponseSchema = z.object({
  repository: z
    .object({
      object: z
        .object({
          associatedPullRequests: z
            .object({ nodes: z.array(PullRequestNodeSchema.nullable()).nullable() })
            .nullable()
            .optional(),
        })
        .nullable(),
    })
    .nullable(),
});

const COMMIT_ENRICHMENT_QUERY = `
  query RepoGhostCommit($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Commit {
          associatedPullRequests(first: 10) {
            nodes {
              number
              title
              body
              url
              state
              mergedAt
              comments(first: 20) {
                nodes {
                  author { login }
                  body
                  createdAt
                }
              }
              closingIssuesReferences(first: 10) {
                nodes {
                  number
                  title
                  body
                  url
                  state
                  comments(first: 20) {
                    nodes {
                      author { login }
                      body
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface GitHubEnrichment {
  pullRequests: PRInfo[];
  issues: IssueInfo[];
}

export interface GitHubEnrichmentOptions {
  enabled?: boolean;
  githubToken?: string;
  requestTimeoutMs: number;
  repository?: {
    owner: string;
    name: string;
  };
  cwd?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRateLimitError(error: unknown): boolean {
  const status =
    error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  return status === 403 || status === 429 || /rate limit/i.test(errorMessage(error));
}

function commentsFrom(
  connection: z.infer<typeof CommentsConnectionSchema>,
): Array<{ author: string; body: string; createdAt: string }> {
  return (connection.nodes ?? [])
    .filter((comment) => comment !== null)
    .map((comment) => ({
      author: comment.author?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.createdAt,
    }));
}

async function getRepository(
  options: GitHubEnrichmentOptions,
): Promise<z.infer<typeof RepositorySchema>> {
  if (options.repository !== undefined) {
    return RepositorySchema.parse(options.repository);
  }

  const git = simpleGit(options.cwd ?? process.cwd());
  let remoteUrl: string;
  try {
    remoteUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
  } catch {
    throw new Error("Could not find an origin remote for GitHub enrichment.");
  }

  const normalizedUrl = remoteUrl.replace(/^git@github\.com:/i, "https://github.com/");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error(
      "The origin remote is not a valid GitHub URL; the remote value is intentionally omitted.",
    );
  }
  if (parsedUrl.hostname.toLowerCase() !== "github.com") {
    throw new Error(
      "GitHub enrichment requires a github.com origin in owner/repository form; the remote value is intentionally omitted.",
    );
  }
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const rawName = segments[1];
  if (owner === undefined || rawName === undefined || segments.length !== 2) {
    throw new Error(
      "The origin remote does not identify a GitHub owner and repository; the remote value is intentionally omitted.",
    );
  }
  return RepositorySchema.parse({ owner, name: rawName.replace(/\.git$/i, "") });
}

function toPullRequest(node: z.infer<typeof PullRequestNodeSchema>): PRInfo {
  return PRInfoSchema.parse({
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    state: node.state,
    mergedAt: node.mergedAt,
    comments: commentsFrom(node.comments),
  });
}

function toIssue(node: z.infer<typeof IssueNodeSchema>): IssueInfo {
  return IssueInfoSchema.parse({
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    state: node.state,
    comments: commentsFrom(node.comments),
  });
}

async function fetchCommitEnrichment(
  token: string,
  sha: string,
  repository: z.infer<typeof RepositorySchema>,
  timeoutMs: number,
): Promise<GitHubEnrichment> {
  const client = graphql.defaults({
    headers: { authorization: `token ${token}` },
    request: { signal: AbortSignal.timeout(timeoutMs) },
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await client(COMMIT_ENRICHMENT_QUERY, {
        ...repository,
        expression: sha,
      });
      const validated = EnrichmentResponseSchema.parse(response);
      const pullRequestNodes =
        validated.repository?.object?.associatedPullRequests?.nodes ?? [];
      const pullRequests = pullRequestNodes
        .filter((pullRequest) => pullRequest !== null)
        .map(toPullRequest);
      const issues = new Map<number, IssueInfo>();
      for (const pullRequest of pullRequestNodes) {
        if (pullRequest === null) continue;
        for (const issue of pullRequest.closingIssuesReferences.nodes ?? []) {
          if (issue !== null) issues.set(issue.number, toIssue(issue));
        }
      }
      return { pullRequests, issues: [...issues.values()] };
    } catch (error) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES || !isRateLimitError(error)) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, RATE_LIMIT_BACKOFF_MS * 2 ** attempt),
      );
    }
  }
}

export async function enrichCommit(
  sha: string,
  options: GitHubEnrichmentOptions,
): Promise<GitHubEnrichment> {
  const token = options.githubToken ?? process.env.GITHUB_TOKEN;
  if (options.enabled === false || !token) {
    return { pullRequests: [], issues: [] };
  }

  const validatedSha = GitShaSchema.parse(sha);
  let repository: z.infer<typeof RepositorySchema>;
  try {
    repository = await getRepository(options);
  } catch {
    console.warn(
      "repo-ghost: GitHub enrichment skipped because the origin remote could not be resolved.",
    );
    return { pullRequests: [], issues: [] };
  }

  try {
    return await requestLimit(() =>
      fetchCommitEnrichment(token, validatedSha, repository, options.requestTimeoutMs),
    );
  } catch {
    console.warn("repo-ghost: GitHub enrichment failed; request details redacted.");
    throw new Error("GitHub enrichment failed; details redacted.");
  }
}
