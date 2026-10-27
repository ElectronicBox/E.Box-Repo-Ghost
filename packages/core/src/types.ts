import { z } from "zod";

const GitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);

export const CommitInfoSchema = z.object({
  sha: GitShaSchema,
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string().min(1),
  message: z.string(),
  filePath: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const PRCommentSchema = z.object({
  author: z.string().min(1),
  body: z.string(),
  createdAt: z.string().min(1),
});

export const IssueCommentSchema = PRCommentSchema;

export const PRInfoSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().nullable(),
  comments: z.array(PRCommentSchema),
});

export const IssueInfoSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED"]),
  comments: z.array(IssueCommentSchema),
});

export const LineStorySchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  lineContent: z.string(),
  commit: CommitInfoSchema,
  pullRequests: z.array(PRInfoSchema),
  issues: z.array(IssueInfoSchema),
  backstory: z.string(),
  cached: z.boolean(),
});

export const RiskEntrySchema = z.object({
  filePath: z.string().min(1),
  commitCount: z.number().int().nonnegative(),
  distinctAuthors: z.number().int().nonnegative(),
  revertCount: z.number().int().nonnegative(),
  churn: z.number().int().nonnegative(),
  riskScore: z.number().finite().min(0).max(100),
});

export const ConfigSchema = z.object({
  provider: z.enum(["ollama", "anthropic", "openai-compatible"]).default("ollama"),
  model: z.string().min(1).default("llama3.2"),
  baseUrl: z.string().url().default("http://localhost:11434"),
  apiKey: z.string().min(1).optional(),
  githubToken: z.string().min(1).optional(),
  enableLlm: z.boolean().default(false),
  enableGitHubEnrichment: z.boolean().default(false),
  cacheTtlMs: z.number().int().positive().default(30 * 24 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  tokenBudget: z.number().int().positive().max(2_000).default(1_800),
  debug: z.boolean().default(false),
});

export const RawStorySchema = z.object({
  commits: z.array(CommitInfoSchema),
  pullRequests: z.array(PRInfoSchema),
  issues: z.array(IssueInfoSchema),
  lineContent: z.string(),
});

export type CommitInfo = z.infer<typeof CommitInfoSchema>;
export type PRComment = z.infer<typeof PRCommentSchema>;
export type PRInfo = z.infer<typeof PRInfoSchema>;
export type IssueComment = z.infer<typeof IssueCommentSchema>;
export type IssueInfo = z.infer<typeof IssueInfoSchema>;
export type LineStory = z.infer<typeof LineStorySchema>;
export type RiskEntry = z.infer<typeof RiskEntrySchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type RawStory = z.infer<typeof RawStorySchema>;
