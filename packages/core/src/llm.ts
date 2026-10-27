import { z } from "zod";
import { ConfigSchema, RawStorySchema, type Config, type RawStory } from "./types.js";
import { EVIDENCE_THIN_FALLBACK, validateStory } from "./validate.js";
const PROMPT_INSTRUCTIONS = `You are a code archaeologist. Given git history and GitHub metadata for a single line of code, write a 2–3 sentence "backstory" explaining WHY this line exists and what problem it solved.

Rules:
- Cite the commit SHA (short form) and PR number if available.
- Quote at most one short snippet from a PR/issue comment, in quotes.
- If evidence is thin or contradictory, say "Evidence is thin — likely [best guess]" instead of fabricating.
- Never invent commit messages, PR numbers, authors, or quotes. Only use provided data.
- Write in plain English for a developer joining the team. No fluff.
- Max 80 words.

Data:`;

const OllamaResponseSchema = z.object({
  message: z.object({ content: z.string() }),
});
const AnthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
});
const OpenAIResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

interface PromptData {
  commits: Array<{
    sha: string;
    authorName: string;
    authoredAt: string;
    message: string;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    comments: Array<{ author: string; body: string }>;
  }>;
  issues: Array<{
    number: number;
    title: string;
    comments: Array<{ author: string; body: string }>;
  }>;
  lineContent: string;
}

class TokenBudgetTooSmallError extends Error {
  constructor(tokenBudget: number) {
    super(`The token budget (${tokenBudget}) is too small for the required backstory prompt.`);
    this.name = "TokenBudgetTooSmallError";
  }
}

class ProviderRequestError extends Error {
  constructor(
    provider: Config["provider"],
    readonly upstreamErrorClass: string,
  ) {
    super(`The ${provider} request failed or timed out.`);
    this.name = "ProviderRequestError";
  }
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const safeNames = new Set([
    "AbortError",
    "Error",
    "FetchError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TimeoutError",
    "TypeError",
    "ZodError",
  ]);
  return safeNames.has(error.name) ? error.name : "Error";
}

function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

function serializeData(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Could not serialize prompt evidence.");
  }
  return serialized.replace(
    /<\/?(COMMITS|PRS|ISSUES|LINE_CONTENT)>/gi,
    (tag) => `&lt;${tag.slice(1, -1)}&gt;`,
  );
}

function renderPrompt(data: PromptData): string {
  return `${PROMPT_INSTRUCTIONS}
<COMMITS>${serializeData(data.commits)}</COMMITS>
<PRS>${serializeData(data.pullRequests)}</PRS>
<ISSUES>${serializeData(data.issues)}</ISSUES>
<LINE_CONTENT>${serializeData(data.lineContent)}</LINE_CONTENT>`;
}

function toPromptData(story: RawStory): PromptData {
  return {
    commits: story.commits.slice(0, 20).map((commit) => ({
      sha: commit.sha,
      authorName: commit.authorName.slice(0, 100),
      authoredAt: commit.authoredAt,
      message: commit.message.slice(0, 200),
    })),
    pullRequests: story.pullRequests.slice(0, 10).map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title.slice(0, 200),
      comments: pullRequest.comments.slice(0, 10).map((comment) => ({
        author: comment.author.slice(0, 100),
        body: comment.body.slice(0, 300),
      })),
    })),
    issues: story.issues.slice(0, 10).map((issue) => ({
      number: issue.number,
      title: issue.title.slice(0, 200),
      comments: issue.comments.slice(0, 10).map((comment) => ({
        author: comment.author.slice(0, 100),
        body: comment.body.slice(0, 300),
      })),
    })),
    lineContent: story.lineContent.slice(0, 1_000),
  };
}

function dropLastComment(data: PromptData): boolean {
  for (const pullRequest of data.pullRequests.slice().reverse()) {
    if (pullRequest.comments.length > 0) {
      pullRequest.comments.pop();
      return true;
    }
  }
  for (const issue of data.issues.slice().reverse()) {
    if (issue.comments.length > 0) {
      issue.comments.pop();
      return true;
    }
  }
  return false;
}

export function buildPrompt(story: RawStory, config: Config): string {
  const validatedStory = RawStorySchema.parse(story);
  const validatedConfig = ConfigSchema.parse(config);
  const data = toPromptData(validatedStory);
  let prompt = renderPrompt(data);

  while (estimateTokens(prompt) > validatedConfig.tokenBudget) {
    if (dropLastComment(data)) {
      prompt = renderPrompt(data);
      continue;
    }
    if (data.pullRequests.length > 1) {
      data.pullRequests.pop();
    } else if (data.issues.length > 1) {
      data.issues.pop();
    } else if (data.commits.length > 1) {
      data.commits.pop();
    } else if (data.lineContent.length > 0) {
      data.lineContent = data.lineContent.slice(0, Math.floor(data.lineContent.length / 2));
    } else {
      throw new TokenBudgetTooSmallError(validatedConfig.tokenBudget);
    }
    prompt = renderPrompt(data);
  }

  return prompt;
}

function providerEndpoint(config: Config): string {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  switch (config.provider) {
    case "ollama":
      // TODO(docs): explain how to install the default model with `ollama pull llama3.2`.
      return `${baseUrl}${baseUrl.endsWith("/api") ? "" : "/api"}/chat`;
    case "anthropic":
      return `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/messages`;
    case "openai-compatible":
      return `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  }
}

function providerApiKey(config: Config): string | undefined {
  if (config.apiKey !== undefined) return config.apiKey;
  switch (config.provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai-compatible":
      return process.env.OPENAI_API_KEY;
    case "ollama":
      return undefined;
  }
}

async function requestCompletion(prompt: string, config: Config): Promise<string> {
  const apiKey = providerApiKey(config);
  if (config.provider !== "ollama" && !apiKey) {
    throw new Error(
      `The ${config.provider} provider requires an API key in configuration or its environment variable.`,
    );
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: Record<string, unknown>;
  switch (config.provider) {
    case "ollama":
      if (apiKey !== undefined) headers.authorization = "Bearer " + apiKey;
      body = {
        model: config.model,
        messages: [{ role: "system", content: prompt }],
        stream: false,
        options: { num_predict: 256 },
      };
      break;
    case "anthropic":
      if (apiKey === undefined) {
        throw new Error("Anthropic provider requires an API key.");
      }
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: config.model,
        max_tokens: 256,
        system: prompt,
        messages: [{ role: "user", content: "Write the requested backstory." }],
      };
      break;
    case "openai-compatible":
      if (apiKey === undefined) {
        throw new Error("OpenAI-compatible provider requires an API key.");
      }
      headers.authorization = "Bearer " + apiKey;
      body = {
        model: config.model,
        max_tokens: 256,
        messages: [{ role: "system", content: prompt }],
      };
      break;
  }

  let response: Response;
  try {
    response = await fetch(providerEndpoint(config), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new ProviderRequestError(config.provider, safeErrorClass(error));
  }
  if (!response.ok) {
    throw new Error(`The ${config.provider} provider returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The ${config.provider} provider returned invalid JSON.`);
  }

  switch (config.provider) {
    case "ollama":
      return OllamaResponseSchema.parse(payload).message.content;
    case "anthropic": {
      const validated = AnthropicResponseSchema.parse(payload);
      const text = validated.content.find((item) => item.type === "text")?.text;
      if (text === undefined) throw new Error("Anthropic returned no text content.");
      return text;
    }
    case "openai-compatible": {
      const validated = OpenAIResponseSchema.parse(payload);
      const text = validated.choices[0]?.message.content;
      if (text === undefined) throw new Error("The OpenAI-compatible provider returned no text.");
      return text;
    }
  }
}

function truncateToLastFullSentence(summary: string, maxWords: number): string {
  const sentences = summary.match(/[^.!?]+[.!?]+(?:["'”’)]*)/g) ?? [];
  let result = "";
  for (const sentence of sentences) {
    const candidate = result.length === 0 ? sentence.trim() : `${result} ${sentence.trim()}`;
    if (candidate.split(/\s+/).length > maxWords) break;
    result = candidate;
  }
  return result;
}

export async function summarize(story: RawStory, config: Config): Promise<string> {
  const validatedStory = RawStorySchema.parse(story);
  const validatedConfig = ConfigSchema.parse(config);
  if (
    validatedStory.commits.length === 0 &&
    validatedStory.pullRequests.length === 0 &&
    validatedStory.issues.length === 0
  ) {
    return EVIDENCE_THIN_FALLBACK;
  }
  if (!validatedConfig.enableLlm) {
    return EVIDENCE_THIN_FALLBACK;
  }

  let prompt: string;
  try {
    prompt = buildPrompt(validatedStory, validatedConfig);
  } catch (error) {
    if (error instanceof TokenBudgetTooSmallError) {
      return EVIDENCE_THIN_FALLBACK;
    }
    throw error;
  }
  if (validatedConfig.debug) {
    console.debug(
      `repo-ghost: estimated LLM prompt tokens ${estimateTokens(prompt)}/${validatedConfig.tokenBudget}.`,
    );
  }
  let rawSummary: string;
  try {
    rawSummary = await requestCompletion(prompt, validatedConfig);
  } catch (error) {
    if (validatedConfig.debug) {
      const errorClass =
        error instanceof ProviderRequestError ? error.upstreamErrorClass : safeErrorClass(error);
      console.debug(`repo-ghost: LLM request error class ${errorClass}.`);
    }
    throw error;
  }

  let summary: string;
  try {
    summary = z.string().trim().min(1).parse(rawSummary);
  } catch (error) {
    if (validatedConfig.debug) {
      console.debug(`repo-ghost: LLM response error class ${safeErrorClass(error)}.`);
    }
    throw error;
  }
  if (summary.split(/\s+/).length > 80) {
    summary = truncateToLastFullSentence(summary, 80);
    if (summary.length === 0) return EVIDENCE_THIN_FALLBACK;
  }
  const validation = validateStory(summary, validatedStory);
  if (!validation.ok) {
    console.warn("repo-ghost: discarded an LLM summary that lacked evidence.");
    return EVIDENCE_THIN_FALLBACK;
  }
  return summary;
}
