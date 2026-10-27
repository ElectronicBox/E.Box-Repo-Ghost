# repo-ghost

![repo-ghost demo](docs/hero.gif)

> Hero GIF placeholder: replace `docs/hero.gif` with the recorded 30-second walkthrough.

## Why

`git blame` tells you who changed a line, but not why it survived.
repo-ghost connects local history, optional GitHub context, and grounded summaries.
It helps a new maintainer understand risk before changing unfamiliar code.

**Runs 100% locally / no telemetry.** Git history, cache, prompts, and provider calls stay on your machine unless you explicitly configure a remote LLM or GitHub enrichment.

## Install in 30 seconds

```bash
git clone https://github.com/example/repo-ghost.git
cd repo-ghost
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

In VS Code, open the repository and run **Repo Ghost: Enable Provider**, then use **Repo Ghost: Show Risk Map** or hover a source line.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `repoGhost.provider` | `ollama` | `ollama`, `anthropic`, or `openai-compatible`. |
| `repoGhost.model` | `llama3.2` | Model name passed to the provider. |
| `repoGhost.baseUrl` | `http://localhost:11434` | Provider endpoint. |
| `repoGhost.apiKey` | unset | Explicit local key; takes precedence over `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. |
| `repoGhost.enableLlm` | `false` | Application-scoped consent flag. The modal is the recommended path. |
| `repoGhost.enableGitHubEnrichment` | `false` | Add pull request and issue context when a token is available. |
| `repoGhost.cacheTtlMs` | 30 days | Line-story cache lifetime. |
| `repoGhost.requestTimeoutMs` | 30 seconds | Provider request timeout. |
| `repoGhost.tokenBudget` | 1800 | Maximum prompt budget. |
| `repoGhost.debug` | `false` | Safe diagnostic logging only; secrets are never logged. |

### Consent paths

There are three explicit opt-in paths:

1. **VS Code modal:** run `repo-ghost.enableProvider`. This writes the application-scoped `repoGhost.enableLlm` setting.
2. **VS Code settings:** manually set `repoGhost.enableLlm: true`. This is also explicit consent and is documented here.
3. **CLI:** set `REPO_GHOST_ENABLE_LLM=1` for one CLI invocation or shell session. Without it, `explain` exits successfully with an enable-provider message and never calls an LLM.

GitHub enrichment uses the VS Code SecretStorage token first, then `GITHUB_TOKEN`. The standalone CLI has no SecretStorage and uses `GITHUB_TOKEN` only. Tokens are never printed.

## How it works

```text
source line
    |
    v
git blame + file history ---- optional GitHub enrichment
    |                                  |
    +------------ evidence ------------+
                       |
                       v
              grounded prompt
                       |
             local/explicit provider
                       |
                       v
                 line story
```

The cache key includes the file path, line content hash, and repository HEAD SHA. Risk maps use first-parent history and aggregate commits, author diversity, reverts, and churn.

## What is new vs `git blame`?

`git blame` identifies the last commit for a line. repo-ghost adds the surrounding file history, optional review context, evidence-grounded explanation, cache-aware hover feedback, and a sortable repository risk map. It does not replace blame; it explains and prioritizes what blame alone cannot.

## Claude Code skill

```bash
repo-ghost explain src/auth.ts:42 --dry-run
repo-ghost explain src/auth.ts:42 --json
repo-ghost risk-map src --json
```

`--dry-run` prints the exact prompt without sending it. The CLI has no access to VS Code SecretStorage and never prints credentials.

## Roadmap

- **v0.2:** per-function risk map, function-level churn and ownership boundaries.
- **v0.2:** richer GitHub review-thread enrichment.
- **v0.3:** repository-wide story navigation and exportable reports.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter repo-ghost-vscode build
```

Licensed under the MIT License.
