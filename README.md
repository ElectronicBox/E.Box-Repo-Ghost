# repo-ghost

![repo-ghost demo](docs/hero.gif)

> Hero GIF placeholder — record a 5s hover demo here before launch.

_git blame tells you who and when. repo-ghost tells you why — and which files are landmines._

## Why

Unfamiliar code is risky because its history is scattered across commits, reviews, and issue context.
repo-ghost assembles that evidence around the line you are reading.
It gives maintainers a grounded explanation without changing the workspace.

## Install in 30 seconds

### VS Code

```bash
git clone https://github.com/ElectronicBox/E.Box-Repo-Ghost.git
cd E.Box-Repo-Ghost
corepack enable
pnpm install
pnpm --filter repo-ghost-vscode build
```

Open the repository in VS Code, run **Repo Ghost: Enable Provider**, then hover a source line.

If the hover says **“Repo Ghost could not reach the ollama provider,”** start Ollama and make
sure the configured model is installed:

```bash
ollama serve
ollama pull llama3.2
```

### Claude Code CLI skill

```bash
git clone https://github.com/ElectronicBox/E.Box-Repo-Ghost.git
cd E.Box-Repo-Ghost
corepack enable
pnpm install
pnpm --filter @repo-ghost/claude-skill build
pnpm --filter @repo-ghost/claude-skill exec repo-ghost explain src/auth.ts:42
```

## Privacy and consent

**repo-ghost runs 100% locally, sends no telemetry, and fails closed until a provider is explicitly enabled.**
Git history, prompts, cache data, and local provider calls stay on the machine. GitHub enrichment is
opt-in and requires a token.

There are three explicit consent paths:

1. **VS Code modal:** run `Repo Ghost: Enable Provider`. The modal selects a provider and writes
   `repoGhost.enableLlm: true`.
2. **VS Code setting:** manually set `repoGhost.enableLlm: true`. This is explicit consent even
   without using the modal.
3. **CLI:** set `REPO_GHOST_ENABLE_LLM=1` for the invocation or shell session. Without it,
   `explain` exits 0 with the enable-provider message and never calls the LLM.

## Configuration

| Setting | Default | Scope | Description |
| --- | --- | --- | --- |
| `repoGhost.provider` | `ollama` | window | `ollama`, `anthropic`, or `openai-compatible`. |
| `repoGhost.model` | `llama3.2` | window | Model name passed to the provider. |
| `repoGhost.baseUrl` | `http://localhost:11434` | window | Provider endpoint URL. |
| `repoGhost.apiKey` | unset | window | Explicit local key; takes precedence over `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. |
| `repoGhost.enableLlm` | `false` | **application** | Consent flag; modal-only is the recommended path. |
| `repoGhost.enableGitHubEnrichment` | `false` | window | Add pull request and issue context when a token is available. |
| `repoGhost.cacheTtlMs` | `2592000000` | window | Cache lifetime in milliseconds. |
| `repoGhost.requestTimeoutMs` | `30000` | window | Provider and GitHub request timeout in milliseconds. |
| `repoGhost.tokenBudget` | `1800` | window | Maximum prompt token budget. |
| `repoGhost.debug` | `false` | window | Enable safe diagnostic logging only. |

## How it works

```text
line
  |
  v
git blame
  |
  v
git log
  |
  v
GitHub PRs
  |
  v
LLM
  |
  v
validateStory
  |
  v
cache
  |
  v
hover
```

The extension reads blame and first-party Git history, optionally adds GitHub review context, and
asks an explicitly enabled provider for a short evidence-grounded story. `validateStory` rejects
unsupported commit, PR, issue, or quoted-comment claims before the result is cached and shown.

## What is new vs `git blame` and GitLens?

### Genuinely new in repo-ghost

- An LLM-synthesized causal narrative grounded in local history and optional review metadata.
- A local-first default that does not call an LLM until the user explicitly enables one.
- Claude Code skill packaging for the same explain and risk-map workflows.

### Not new

Line history itself already exists in `git blame`, GitLens, and Git tooling. repo-ghost does not
claim to invent blame or commit navigation; it connects that evidence to a cautious explanation and
repository-level risk prioritization.

## Security

VS Code GitHub tokens live in VS Code SecretStorage. The CLI uses `GITHUB_TOKEN` from the environment;
it has no access to VS Code SecretStorage. Tokens are never logged, never written to
`.repo-ghost/cache.json`, and are redacted at the cache boundary. The risk-map webview uses a
per-render CSP nonce for every inline script and style block and builds table content with DOM APIs,
not unsanitized `innerHTML`.

## Roadmap

- **v0.2:** per-function risk map.
- **v0.2:** cache lockfile for multi-process concurrency.
- **v0.2:** `fsync` before rename for cache durability.
- **v0.2:** raise `git.ts` coverage.

## Contributing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Pull requests should preserve the read-only workspace contract, fail-closed consent model, and
no-telemetry guarantee.

## MIT License

Copyright (c) 2025 repo-ghost contributors

Released under the [MIT License](./LICENSE).
