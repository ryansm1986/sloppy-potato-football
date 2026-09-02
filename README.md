# Sloppy Potato Fantasy Football

A small-group fantasy football command center for Potato Bowl After Dark. The primary format is PPR redraft and the selected visual direction is **Dark Draft**.

## Current working slice

- Responsive Dark Draft application shell and Huddle dashboard
- Rankings Center with a private drag-and-drop board and a clearly separate, read-only Agent Rankings workspace
- Cloud-synced personal rankings with optimistic edit protection, position/all-position copy with confirmation, favorite canonical sources, and saved layout preferences
- Research Desk with cloud schedules, an offline-safe job queue, runner status, structured results, and ranking snapshot ingestion
- Outbound-only Codex runner bridge with scoped tokens, bounded jobs, read-only execution, structured results, retries, and heartbeats
- Windows desktop companion with a system tray, close-to-tray, launch-at-login, secure runner-token storage, runner controls, logs, and notifications
- D1 canonical player/league model, Sleeper data utility, and Yahoo integration groundwork
- Immutable ranking snapshots, canonical source registry, aliases, provenance, refresh metadata, and protected ingestion APIs
- Owner-authenticated personal-ranking storage with canonical-player filtering and revision conflicts instead of silent cross-device overwrites
- Type checking, UI/Worker/runner/desktop tests, production builds, and checked Cloudflare deployment workflow

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

`bridge:setup` creates separate legacy runner and Research Desk owner tokens, stores both in the gitignored `.env.runner`, and prints the owner token for browser setup. Never commit or share either token. If you need it again, read `RESEARCH_OWNER_TOKEN` locally from `.env.runner`; do not paste it into chat. The legacy shared runner token is a bootstrap path only: the first desktop enrollment permanently switches runner authentication to independently revocable device credentials.

Use `pnpm runner:once` to claim at most one approved job. The continuous `pnpm runner` process polls every 15 seconds and must remain running for jobs to execute; queued work waits safely while the computer is off. Codex runs in an isolated temporary workspace with user configuration and rules disabled, live web search enabled, a read-only sandbox, a four-minute timeout, and schema-validated output.

## Windows desktop companion

Build both the installer and portable app with:

```bash
pnpm desktop:dist
```

Artifacts are written to `release-desktop/`. In the desktop app's Research Desk, choose **Set up this computer**, give it a name, and enter `RESEARCH_OWNER_TOKEN`. Cloudflare returns a one-time device credential directly to the privileged desktop process, which Windows encrypts with DPAPI; the page never receives or reads it back. You can then start, pause after the current job, run one queued job, or stop the runner from the page or tray. Closing the window keeps the app in the tray by default.

Bad, expired, and revoked credentials stop retrying after the first rejection. Use **Runner credential** to replace one or remove its encrypted local copy. Local removal does not revoke a copied credential; use **Connected Runners** in the owner-authenticated Research Desk to revoke it in Cloudflare.

It is safe to run the companion on a laptop and desktop at the same time. Each installation has a persistent random identity, and Cloudflare atomically leases each job to only one runner. Personal-ranking saves use revisions, so a stale device is asked to reload instead of overwriting a newer board.

### Publishing desktop updates

Installed NSIS copies check the public GitHub Releases feed without putting a GitHub token in the app. When a newer version is available, the desktop UI offers an explicit download and then an explicit restart-to-install action. The portable build does not auto-update; download a new portable executable manually.

To publish an update, raise the semver `version` in `package.json` (and the lockfile), merge the tested change to `main`, then have Luna create and push the matching tag, such as `v0.1.1`. The `Publish desktop release` workflow validates that the tag and package version match, runs `pnpm check`, and publishes the NSIS installer, blockmap, and `latest.yml` to a GitHub Release. Do not reuse a version or move an existing release tag.

The current Windows packages are unsigned, so Windows SmartScreen may warn during install or update. Code signing is strongly recommended before wider sharing.

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
