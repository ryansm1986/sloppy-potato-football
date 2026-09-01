# Sloppy Potato Fantasy Football

A small-group fantasy football command center for Potato Bowl After Dark. The primary format is PPR redraft and the selected visual direction is **Dark Draft**.

## Current working slice

- Responsive Dark Draft application shell and Huddle dashboard
- Rankings Center with a private drag-and-drop board and a clearly separate, read-only Agent Rankings workspace
- Browser-persisted personal rankings, position/all-position copy with confirmation, favorite canonical sources, and saved layout preferences
- Research Desk with local job staging and structured agent-result display; the CLI runner bridge is the next integration
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
