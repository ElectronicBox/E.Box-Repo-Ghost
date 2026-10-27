---
name: repo-ghost
description: "Use repo-ghost from Claude Code to explain a line's history or generate a repository risk map."
---

# Repo Ghost

Use the local-first CLI to inspect repository history without modifying source files.

```bash
repo-ghost explain src/file.ts:42
repo-ghost explain src/file.ts:42 --json
repo-ghost explain src/file.ts:42 --dry-run
repo-ghost risk-map src --json
```

The CLI never reads Claude Code credentials and never prints API or GitHub tokens. LLM summaries require explicit provider enablement. `--dry-run` prints the exact prompt that would be sent and performs no network request.

## Example

```text
$ repo-ghost explain src/auth.ts:42 --dry-run
You are a code archaeologist. Given git history and GitHub metadata for a single line of code...
```
