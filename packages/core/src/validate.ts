import { z } from "zod";
import { RawStorySchema, type RawStory } from "./types.js";

export const EVIDENCE_THIN_FALLBACK =
  "Evidence is thin — likely this line predates available history or has no linked metadata.";

const HEX_PROSE_WHITELIST = new Set(["deadbeef", "cafebabe", "facefeed", "8badf00d"]);

export type StoryValidation =
  | { ok: true }
  | { ok: false; violations: string[] };

function quotedSnippets(summary: string): string[] {
  const snippets: string[] = [];
  for (const match of summary.matchAll(/“([^”]+)”|"([^"]+)"/g)) {
    const snippet = match[1] ?? match[2];
    if (snippet !== undefined) snippets.push(snippet);
  }
  for (const match of summary.matchAll(/'([^'\r\n]{3,})'/g)) {
    const snippet = match[1];
    if (snippet !== undefined) snippets.push(snippet);
  }
  return snippets;
}

export function validateStory(story: string, evidence: RawStory): StoryValidation {
  const summary = z.string().trim().min(1).parse(story);
  const validatedEvidence = RawStorySchema.parse(evidence);
  const violations: string[] = [];
  const fullCommitShas = validatedEvidence.commits.map((commit) => commit.sha.toLowerCase());

  for (const match of summary.matchAll(/\b[0-9a-f]{7,64}\b/gi)) {
    const candidate = match[0].toLowerCase();
    if (HEX_PROSE_WHITELIST.has(candidate)) continue;
    if (
      candidate.length < 7 ||
      !fullCommitShas.some((fullSha) => fullSha.startsWith(candidate))
    ) {
      violations.push("Summary cites a commit SHA not present in the evidence.");
    }
  }

  // References are validated by membership across PRs and issues; their # syntax is shared.
  const validNumbers = new Set([
    ...validatedEvidence.pullRequests.map((pullRequest) => String(pullRequest.number)),
    ...validatedEvidence.issues.map((issue) => String(issue.number)),
  ]);
  for (const match of summary.matchAll(/\bPR\s*#?(\d+)\b|#(\d+)\b/gi)) {
    const number = match[1] ?? match[2];
    if (number !== undefined && !validNumbers.has(number)) {
      violations.push("Summary cites a PR or issue number not present in the evidence.");
    }
  }

  const comments = [
    ...validatedEvidence.pullRequests.flatMap((pullRequest) => pullRequest.comments),
    ...validatedEvidence.issues.flatMap((issue) => issue.comments),
  ].map((comment) => comment.body.replace(/\s+/g, " ").trim().toLowerCase());
  const quotes = quotedSnippets(summary);
  if (quotes.length > 1) {
    violations.push("Summary contains more than one quoted comment snippet.");
  }
  if (
    quotes.some(
      (quote) =>
        !comments.some((comment) =>
          comment.includes(quote.replace(/\s+/g, " ").trim().toLowerCase()),
        ),
    )
  ) {
    violations.push("Summary contains a quote not present in the provided comments.");
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
