# Sloppy Potato Fantasy Football

A small-group fantasy football command center for Potato Bowl After Dark. The primary format is PPR redraft and the selected visual direction is **Dark Draft**.

## Current working slice

- Responsive Dark Draft application shell and Huddle dashboard
- Rankings Center with a private drag-and-drop board and a clearly separate, read-only Agent Rankings workspace
- Browser-persisted personal rankings, position/all-position copy with confirmation, favorite canonical sources, and saved layout preferences
- Research Desk with a cloud-backed job queue, runner status, structured results, and ranking snapshot ingestion
- Outbound-only Codex runner bridge with scoped tokens, bounded jobs, read-only execution, structured results, retries, and heartbeats
- D1 canonical player/league model, Sleeper data utility, and Yahoo integration groundwork
- Immutable ranking snapshots, canonical source registry, aliases, provenance, refresh metadata, and protected ingestion APIs
- Dormant owner-scoped ranking-list tables ready for Cloudflare Access identity; no unsafe public personal-write endpoint
- Type checking, UI/Worker tests, production build, and checked Cloudflare deployment workflow

## Local development

Requirements: Node.js 22.12 or newer and pnpm.

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

Open `http://localhost:5173` unless Vite selects another available port.

## Validation

```bash
pnpm check
```

This runs TypeScript checks, UI tests, Worker/D1 tests, and the production build.

Localhost import and agent-ingestion writes work without authentication. Before sharing or deploying, configure the admin secret:

```bash
pnpm wrangler secret put IMPORT_ADMIN_TOKEN
```

Send it as `Authorization: Bearer <token>` for protected import, source-registry, and ranking-snapshot writes.

## Local research bridge

The Codex runner polls Cloudflare over outbound HTTPS; it never opens a port on your computer. Run the one-time setup after authenticating Wrangler and Codex:

```bash
codex login status
pnpm bridge:setup
pnpm runner:doctor
pnpm runner
```

`bridge:setup` creates separate runner and Research Desk owner tokens, stores both in the gitignored `.env.runner`, and prints the owner token for browser setup. Never commit or share either token. If you need it again, read `RESEARCH_OWNER_TOKEN` locally from `.env.runner`; do not paste it into chat. If you prefer manual configuration, set the Cloudflare secrets `AGENT_RUNNER_TOKEN` and `RESEARCH_OWNER_TOKEN`, then create `.env.runner` with `SLOPPY_POTATO_API_URL` and the matching tokens.

Use `pnpm runner:once` to claim at most one approved job. The continuous `pnpm runner` process polls every 15 seconds and must remain running for jobs to execute; queued work waits safely while the computer is off. Codex runs in an isolated temporary workspace with user configuration and rules disabled, live web search enabled, a read-only sandbox, a four-minute timeout, and schema-validated output.

## Deployment

`pnpm deploy` runs the complete validation gate, applies pending remote D1 migrations, and deploys. The GitHub workflow does the same on every push to `main`, then smoke-tests production. Setup details are in [docs/deployment.md](docs/deployment.md).

## Project map

- `src/` — React client
- `worker/` — Hono API Worker
- `migrations/` — versioned D1 migrations
- `design/` — pen.dev Dark Draft product system
- `docs/product-plan.md` — product and delivery plan
- `docs/data-model.md` — canonical league/player and rankings storage model
- `docs/deployment.md` — checked Cloudflare deployment workflow
- `wrangler.jsonc` — Cloudflare Worker and D1 configuration
