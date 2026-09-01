# Sloppy Potato Fantasy Football

A private, Sleeper-first fantasy football command center for the Potato Bowl After Dark league. The primary format is PPR redraft. The selected visual direction is **Dark Draft**.

## Current working slice

- Responsive Dark Draft application shell
- Huddle dashboard with lineup, prioritized roster news, rank movement, quick actions, and Research Desk handoff
- Routes for My Team, Players, Rankings, Draft Board, and Research Desk
- Cloudflare Worker API with `/api/health`
- Type checking, component testing, and Cloudflare production build

The non-Huddle routes currently contain explicit implementation placeholders. Their approved desktop and mobile designs are in `design/dark-draft-system.pen`.

## Local development

Requirements: Node.js 22.12 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`.

## Validation

```bash
pnpm check
```

This runs TypeScript project checks, Vitest, and the Cloudflare production build.

## Project map

- `src/` — React client
- `worker/` — Hono API Worker
- `design/` — pen.dev comparison and approved Dark Draft product system
- `docs/product-plan.md` — product, architecture, data, agent-runner, and delivery plan
- `wrangler.jsonc` — Cloudflare Worker/static asset configuration

