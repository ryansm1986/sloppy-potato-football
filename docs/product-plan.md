# Sloppy Potato Fantasy Football — Product, Design, and Implementation Plan

Status: Product direction approved; subscription-runner architecture proposed  
Audience: Owner and a small, invite-only group of friends  
Primary constraints: Nearly zero fixed cost, useful fantasy-football research, cited results, and a playful potato-football identity

Approved decisions: Sleeper-first, PPR redraft, Potato Bowl After Dark, Cloudflare Access email allowlist, and local subscription-backed research runners.

## 1. Product statement

Sloppy Potato Fantasy Football is a private fantasy-football command center. It combines league and roster imports, player news, rankings, team analysis, draft preparation, and on-demand research jobs in one responsive web app.

The product should feel like a smart draft-night companion built by a friend, not a commercial sportsbook or an anonymous enterprise dashboard.

## 2. Product principles

1. **Useful before comprehensive.** Prioritize the user's roster, watchlist, and draft board instead of attempting to mirror every fantasy site.
2. **Facts first, agents second.** Deterministic APIs and calculations own factual data. Agents research, compare, explain, and cite.
3. **Sources stay visible.** News and research claims include a source, publication date, retrieval date, and freshness indicator.
4. **Private by default.** Only allowlisted friends can enter. No public profiles, payments, or social feed are needed.
5. **Zero fixed cost where practical.** Prefer free non-commercial APIs, free serverless tiers, caching, and on-demand research.
6. **Potato personality, serious information.** Playful branding should never make tables harder to scan or obscure injuries, dates, ranks, and recommendations.

## 3. MVP scope

### Included

- Invite-only authentication for fewer than 50 people
- Responsive desktop and mobile UI
- Sleeper league, roster, scoring, matchup, and draft import
- Manual team builder and CSV fallback
- Player directory, watchlist, and player detail pages
- Headline/news links associated with players
- Rankings snapshots, tiers, source comparison, and league-specific adjustments
- Dynamic draft cheat sheet with manual drafted-player tracking
- On-demand player research and comparison jobs
- Daily or manual roster digest
- Citations, timestamps, confidence labels, and report history
- Admin controls for sources, users, budgets, failed jobs, and player-ID corrections

### Deferred until the MVP is useful

- Yahoo import, because access now requires an application review and OAuth 2.0
- ESPN, NFL.com, and CBS automated imports without a verified supported API
- Automatic interaction with live platform draft rooms
- Native iOS/Android apps
- Public accounts, subscriptions, payments, or advertising
- Full-text article republication
- Unbounded crawling or scraping
- Automated waiver claims, trades, or lineup changes

## 4. Information architecture

### Primary navigation

1. **Huddle** — personalized home dashboard
2. **My Team** — roster, league context, needs, and alerts
3. **Players** — search, filters, watchlist, and player pages
4. **Rankings** — sources, consensus, tiers, and league-adjusted values
5. **Draft Board** — cheat sheet and manual live draft mode
6. **Research Desk** — launch and review research jobs
7. **Settings** — imports, scoring, sources, users, and budget

### Huddle dashboard

- Greeting and current NFL week
- Roster alerts: injury, role, bye, and meaningful news
- Trending additions from Sleeper
- Latest research reports
- Rank movers and source disagreement
- Quick actions: Import League, Research Player, Compare Players, Open Draft Board
- System freshness panel showing last league sync, player sync, and rankings update

### Player page

- Identity, team, position, bye, and status
- League-specific value and recommendation
- Rank range, tier, ADP when authorized, and recent movement
- News and research timeline
- Usage and historical statistics
- Risks, opportunities, and confidence
- Source links with publication and retrieval times
- Actions: watch, compare, research, add to cheat sheet

## 5. pen.dev design workflow

pen.dev will be the source of truth for UI exploration and the shared design system. Its documented workflow supports `.pen` files in the repository, reusable components, variables, and design-to-code synchronization: [pen.dev design-to-code documentation](https://docs.pen.dev/design-and-code/design-to-code).

Planned repository structure:

```text
design/
  sloppy-potato.pen
  exports/
    direction-a.png
    direction-b.png
    direction-c.png
src/
  components/
  styles/tokens.css
```

### Look-and-feel directions considered

#### A. Tater Tailgate — not selected

Warm, welcoming, and unmistakably football without looking like a betting product.

- Warm cream background, russet brown surfaces, turf green actions
- Mustard-gold highlights and restrained ketchup-red warnings
- Chunky condensed display type for headings; highly readable sans-serif for data
- Soft rectangular cards with stitched or hash-mark details
- A simple potato-in-a-football-helmet mascot for empty states and loading moments
- Subtle paper and turf textures only in large decorative areas

Best for: a friendly product that remains comfortable during long draft sessions.

#### B. Coach's Clipboard

A scouting-notebook presentation with stronger analytical character.

- Off-white paper, graphite, dark green, and yellow highlighter
- Field diagrams, handwritten annotations, tabs, and clipped report cards
- Rank movement and research evidence treated like scouting notes
- Denser information layout than Direction A

Best for: users who want the product to feel like a personal research notebook.

Risk: handwritten and paper effects can become visually noisy.

#### C. Potato Bowl After Dark — selected

A dark draft-night and arcade-inspired direction.

- Charcoal/navy surfaces, stadium green, electric gold, and red alerts
- Scoreboard typography, luminous chips, and a more expressive mascot
- Strong presentation on TVs and during a group draft

Best for: high-energy draft-night use.

Risk: dark dense tables can be tiring for everyday news reading.

### Selected direction

Use **Dark Draft** as the canonical foundation. It should feel like a calm late-night sports broadcast: serious enough for dense research, but unmistakably Sloppy Potato through its identity and voice.

- Near-black canvas with layered charcoal surfaces rather than navy
- Warm amber/orange as the primary action, active-rank, draft-value, and emphasis color
- Warm off-white text to reduce glare, with muted slate secondary text
- Green reserved for positive/ready states and red reserved for injuries, stale data, errors, and destructive actions
- Condensed editorial sports-display type only for page titles and large numbers
- Tabular, highly readable sans-serif type for rankings and statistics
- A restrained original helmeted-potato mascot in the logo, mobile identity, empty states, and celebrations
- Thin dividers, modest radii, and minimal decoration; no gradients, glossy glassmorphism, betting language, or borrowed league/team marks
- Evidence-first research reports with visible sources, timestamps, runner state, and confirmation boundaries

The initial theme is dark-only to control scope. A light theme can be reconsidered after private-beta readability testing.

### Design tokens

The selected pen.dev variables will synchronize with `src/styles/tokens.css`.

- Semantic colors: background, surface, surface-raised, text, muted, primary, positive, warning, danger, focus
- Position colors for QB, RB, WR, TE, K, DST, and IDP without relying on color alone
- Eight-point spacing system
- Three radii: chip, control, card
- Clear type scales for display, section, body, label, and tabular numbers
- Motion durations respecting `prefers-reduced-motion`
- WCAG AA contrast targets and visible keyboard focus

### First pen.dev frames

The first design pass should show:

- Desktop Huddle dashboard at 1440 px
- Mobile Huddle dashboard at 390 px
- Desktop Player page
- Rankings table with filters and source disagreement
- Draft Board with available/drafted states
- Research job in queued, researching, completed, and failed states
- Core component sheet and token palette

Production UI implementation begins after the Potato Bowl After Dark frames and tokens receive a final visual review.

## 6. Recommended technical architecture

### Stack

- **Frontend:** React, TypeScript, Vite, React Router
- **Styling:** Tailwind CSS backed by custom pen.dev design tokens; Radix primitives only where accessibility behavior is useful
- **Backend:** Cloudflare Worker using Hono
- **Database:** Cloudflare D1 with Drizzle ORM and SQL migrations
- **Static hosting:** The same Cloudflare Worker deployment
- **Authentication:** Cloudflare Access with an explicit email allowlist
- **Validation:** Zod at all API and third-party boundaries
- **Testing:** Vitest, Testing Library, Playwright, and axe accessibility checks
- **Observability:** Structured Worker logs plus a small D1 usage/error ledger
- **Research execution:** A local Node.js companion runner using the subscriber's Codex or Claude Code installation
- **Optional AI fallback:** OpenAI Responses API behind an explicit disabled-by-default configuration flag

This avoids maintaining a server, separate frontend host, paid database, email provider, custom password system, or usage-billed model API. Cloudflare documents 100,000 Worker requests per day and D1 allowances of 5 million rows read and 100,000 rows written per day on the free plan—far beyond expected friend-group traffic: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers/D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Cloudflare Access can protect a `workers.dev` URL without purchasing a domain, and the current free plan is intended for groups under 50 users: [protect a Worker with Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/).

### High-level flow

```text
Browser / PWA
    |
Cloudflare Access (allowlisted email)
    |
React app + Hono API on Cloudflare Workers
    |--------------------------|
Cloudflare D1              External adapters
    |                       |-- Sleeper API
    |                       |-- nflverse datasets
    |                       `-- approved ranking imports
    |
Research job queue <--- outbound polling --- Local companion runner
                                               |-- Codex SDK / app-server
                                               `-- Claude Code CLI
    |
Cached normalized players, leagues, rankings, news, and reports
```

### Local companion runner

Cloudflare Workers cannot install or execute Codex CLI or Claude Code. A small companion process therefore runs on the subscriber's own Windows, macOS, or Linux computer and makes outbound HTTPS requests to claim work. No inbound port, home-server exposure, or persistent cloud VM is required.

The runner:

1. Pairs to an app user with a one-time code.
2. Detects available providers and verifies local authentication.
3. Polls for work assigned to that user.
4. Executes each job in a dedicated read-only workspace with strict turn, tool, time, and output limits.
5. Validates the result against the shared report schema.
6. Uploads the report and citations through a scoped runner token.
7. Sends a heartbeat so the app can show Online, Busy, Rate Limited, or Offline.

Jobs remain queued while the computer is asleep or the runner is closed.

### Why not Next.js for the first version

The application is private and app-like; it does not need public SEO or server-rendered marketing pages. A Vite SPA plus a small Worker API is simpler to deploy, cheaper to operate, and easier to keep within free execution limits.

## 7. Data sources and provider policy

### Sleeper — MVP platform

Sleeper's documented API is read-only, needs no token, is free for non-commercial use, and exposes leagues, rosters, matchups, transactions, drafts, players, and trending players. Sleeper asks clients to remain under 1,000 calls per minute: [Sleeper API](https://docs.sleeper.com/).

Implementation rules:

- Cache league data and synchronize on demand plus a modest scheduled refresh
- Fetch the large player catalog at most daily
- Store stable Sleeper user and player IDs rather than mutable usernames
- Never imply that the app can write lineups or claims through the read-only API

### Yahoo — phase two

Yahoo exposes fantasy leagues, teams, players, and rosters through OAuth 2.0, but applications must now be submitted and reviewed. The application form explicitly asks whether access is for personal or single-league use: [Yahoo Fantasy API](https://sports.yahoo.com/developer/) and [access application](https://sports.yahoo.com/developer/access/).

Yahoo work begins only after Sleeper/manual import is complete and API access is approved.

### nflverse — open historical statistics

Use nflverse's CC BY 4.0 datasets for historical and current statistical context where appropriate, with attribution: [nflverse-data](https://github.com/nflverse/nflverse-data).

### Rankings

Use a layered strategy:

1. User CSV/paste import from sources the user is authorized to access
2. Public links and short attributed observations
3. FantasyPros API only if an API key and terms appropriate for friend sharing are confirmed
4. App-owned derived scores: league scoring, projections, replacement value, positional scarcity, roster need, risk, and manually adjusted tiers

FantasyPros currently documents expert rankings, consensus rankings, news, injuries, projections, and player identifiers in one API, including data from 130+ experts: [FantasyPros API](https://www.fantasypros.com/api-data/) and [API reference](https://api.fantasypros.com/public/v2/docs/). Its terms restrict distribution, so we must obtain appropriate permission before exposing those datasets to friends.

### News

The zero-cost MVP does not copy full articles or continuously scrape the entire web.

- Research jobs search current sources on demand
- The app stores headline, source, URL, dates, player associations, and an original summary
- Roster/watchlist digests batch multiple players to reduce search calls
- Approved RSS feeds can be added when their terms permit it
- Paywalled content is linked, not bypassed or reproduced

## 8. Canonical data model

### Identity and league tables

- `users`
- `allowed_users`
- `leagues`
- `league_members`
- `teams`
- `rosters`
- `roster_players`
- `scoring_settings`
- `provider_syncs`

### Player and football tables

- `players`
- `player_external_ids`
- `player_week_stats`
- `player_status_events`
- `watchlists`

### News and rankings tables

- `sources`
- `news_items`
- `news_player_links`
- `ranking_sources`
- `ranking_snapshots`
- `ranking_entries`
- `projections`

### Research and draft tables

- `research_jobs`
- `research_reports`
- `research_citations`
- `agent_usage`
- `cheat_sheets`
- `cheat_sheet_entries`
- `draft_sessions`
- `draft_picks`

Important unique keys include canonical URL, source plus external record ID, provider plus external player ID, and research request hash. These allow aggressive deduplication and caching.

## 9. API surface

```text
GET    /api/me
GET    /api/health

POST   /api/imports/sleeper
POST   /api/imports/manual
POST   /api/leagues/:leagueId/sync
GET    /api/leagues/:leagueId
GET    /api/leagues/:leagueId/team

GET    /api/players
GET    /api/players/:playerId
PUT    /api/players/:playerId/watch

GET    /api/rankings
POST   /api/rankings/import
GET    /api/news

POST   /api/research/jobs
GET    /api/research/jobs/:jobId
POST   /api/research/jobs/:jobId/cancel

POST   /api/runners/pair-codes
POST   /api/runners/pair
POST   /api/runners/jobs/claim
POST   /api/runners/jobs/:jobId/result
POST   /api/runners/heartbeat

POST   /api/cheat-sheets
PATCH  /api/cheat-sheets/:sheetId
POST   /api/drafts
POST   /api/drafts/:draftId/picks

GET    /api/admin/usage
GET    /api/admin/errors
PUT    /api/admin/allowed-users
```

All writes include an authenticated user identity, validation, authorization, and an audit timestamp.

## 10. Agent and research architecture

### Subscription-backed design

The UI presents multiple specialist capabilities, but the execution layer uses one bounded local run by default and a second verification run only for deep reports or conflicting evidence.

OpenAI's official documentation confirms that local Codex clients can sign in with ChatGPT for subscription access, and that the Codex SDK can be integrated into an application or internal workflow. The app-server authentication protocol also supports ChatGPT browser and device-code flows: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Anthropic documents that Claude Pro and Max subscriptions include Claude Code, and that `claude -p` supports non-interactive JSON output and a maximum-turn limit: [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started), [Claude Code subscriptions](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan), and [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).

### Subscription ownership policy

- The owner's runner may execute owner-approved jobs and publish the resulting reports to the shared library.
- Friends can read shared reports and submit research requests for owner approval.
- A friend who wants immediate self-service research pairs a runner authenticated with that friend's own Codex or Claude subscription.
- ChatGPT or Claude credentials, session files, and subscription tokens never leave the subscriber's computer.
- One person's runner is not exposed as an unrestricted multi-user model endpoint.

### Job flow

1. User submits player, question, league, depth, and freshness requirements.
2. API checks permissions, daily limits, and cache for an equivalent fresh report.
3. API creates a `research_jobs` row and assigns it to the user's runner. Friend requests without a paired runner enter `AWAITING_OWNER_APPROVAL`.
4. The local runner claims an approved job using its scoped token.
5. The runner assembles deterministic league/player context, then invokes the selected local provider.
6. Codex runs through its SDK/app-server in a read-only sandbox with live web search and a structured report schema. Claude Code runs in print mode with JSON output, restricted tools, and a maximum turn count.
7. The runner validates the result locally and uploads it. The cloud API validates it again, including citations, URLs, dates, player identity, and required fields.
8. Valid results become immutable report snapshots. Invalid results fail visibly or receive one bounded repair attempt.

Codex's stable non-interactive command supports live search, JSONL, read-only sandboxing, ephemeral sessions, and a JSON output schema. The SDK is preferred for the runner because OpenAI recommends it for automated jobs and application integration: [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

### Initial research types

- `PLAYER_OUTLOOK`
- `PLAYER_NEWS_REFRESH`
- `PLAYER_COMPARE`
- `RANKING_EXPLAINER`
- `ROSTER_AUDIT`
- `WAIVER_SCAN`
- `DRAFT_PICK_RECOMMENDATION`
- `DAILY_ROSTER_DIGEST`

### Tools exposed to the agent

- `get_player_context(playerId)`
- `get_league_context(leagueId)`
- `get_roster_context(teamId)`
- `get_rankings(playerIds, scoringProfile)`
- `get_recent_stats(playerIds, weekRange)`
- Built-in web search with current sources

The model never writes directly to D1. It returns structured evidence; application code validates and persists it.

### Report requirements

- Player identity and league format
- Generated and source publication timestamps
- Concise summary
- Evidence signals and risks
- Ranking range rather than false precision when experts disagree
- League-specific recommendation
- Confidence level with explanation
- Sources supporting material factual claims
- Explicit `insufficient_evidence` outcome instead of guessing

### Guardrails and usage controls

- User-selectable Codex or Claude provider when both are locally available
- Read-only, dedicated runner workspace with no access to the football repository or unrelated personal files
- Allow only web research and the small set of runner-owned context tools
- Maximum web searches per quick, standard, and deep job
- Maximum turns, execution time, and output size
- Per-user daily job limits
- Cache player research for 12–24 hours based on report type
- Deduplicate simultaneous identical requests
- Approved-source and blocked-domain lists
- Prompt-injection warning in system instructions
- Citations and publication dates required
- No betting recommendations or invented injury predictions
- Detect and display provider rate-limit exhaustion instead of silently switching to paid API credits
- Optional API fallback remains disabled unless the owner deliberately supplies a key and budget

## 11. Rankings and cheat-sheet logic

### Normalization

- Preserve source, expert, format, week, timestamp, and ranking type
- Never mix redraft, dynasty, rookie, rest-of-season, weekly, best-ball, or IDP rankings
- Map imported names to canonical players with a review queue for ambiguity
- Convert ranks into per-position percentiles before comparing very different lists
- Display range, median, movement, source count, and freshness

### League-adjusted player value

Start with transparent calculations rather than an unexplained AI score:

1. Apply league scoring to projections
2. Estimate replacement player by position and roster depth
3. Calculate value over replacement
4. Adjust for starting requirements and flex eligibility
5. Add positional scarcity and tier drop-off
6. Show injury/role uncertainty separately, not hidden inside a rank
7. Add roster-need guidance during the draft

### Draft Board behavior

- Filters by position, tier, team, bye, status, watchlist, and availability
- Keyboard-first drafted-player marking
- Undo history
- Side panel with source links and latest insight
- Automatic roster construction panel
- Best available suggestions with short, inspectable reasons
- Offline-capable cached board so draft-night connectivity does not destroy the experience
- No live platform automation in MVP; manual pick tracking is the reliable baseline

## 12. Security and privacy

- Cloudflare Access email allowlist protects all routes and preview deployments
- Validate the authenticated Access identity server-side
- Keep Codex and Claude subscription credentials only in their official local credential stores
- Store only a revocable, hashed pairing-token verifier in D1; keep the raw runner token in the local OS credential store
- Owner-only admin role
- CSRF protection for state-changing routes
- Strict Content Security Policy
- URL sanitization and safe external-link handling
- Rate limits per user and endpoint
- Minimal personal data: email, display name, and preferences
- No fantasy-platform passwords stored
- Yahoo tokens encrypted if Yahoo is added later
- Redact secrets and tokens from logs
- Export and delete a user's saved data on request

## 13. Operating-cost target

| Item | MVP target | Notes |
|---|---:|---|
| pen.dev | $0 | Currently free; pricing may change later |
| Cloudflare Worker/static hosting | $0 | Free limits are ample for this group |
| Cloudflare D1 | $0 | Requires indexed queries and usage alerts |
| Cloudflare Access | $0 | Free plan intended for under 50 users |
| `workers.dev` URL and TLS | $0 | Custom domain is optional |
| Sleeper API | $0 | Non-commercial, read-only use |
| nflverse | $0 | Attribution required |
| Codex/Claude research | $0 incremental | Uses an existing personal subscription through a local runner and remains subject to plan usage limits |
| Optional model API fallback | $0 when disabled | Requires explicit owner opt-in, key, and budget |
| Custom domain | Optional annual cost | Not required for first release |
| Licensed rankings/news | $0 for MVP | User imports and links until permission is obtained |

pen.dev states that it is currently free: [pen.dev pricing](https://www.pen.dev/pricing). Costs and provider terms should be rechecked before deployment because they can change.

## 14. Implementation phases

### Phase 0 — project foundation

- Initialize Git, TypeScript, formatting, linting, tests, and environment templates
- Document local setup and secrets
- Define provider interfaces and error taxonomy

Acceptance: clean install, test, typecheck, build, and local Worker/D1 startup.

### Phase 1 — Potato Bowl After Dark options in pen.dev

- Create at least three distinct Potato Bowl After Dark look-and-feel options in `design/sloppy-potato-v2.pen`
- Compare identical matchup content across Dark Draft, Clean Command, and Sloppy Arcade directions
- Selected direction: **Dark Draft** (September 1, 2026)
- Extend Dark Draft to every desktop and mobile frame
- Finalize variables, components, responsive rules, loading/empty/error states
- Export review PNGs and synchronize tokens to CSS

Acceptance: approved desktop/mobile frames and component sheet before page implementation.

### Phase 2 — application shell and private deployment

- Build responsive navigation, routing, page shells, and reusable components
- Configure Worker, D1, migrations, preview deployment, and Cloudflare Access
- Add owner/admin authorization

Acceptance: allowlisted users can open preview; other users cannot; core layouts pass accessibility smoke checks.

### Phase 3 — canonical player data and Sleeper import

- Implement provider adapter contracts
- Import players, league settings, members, rosters, matchups, drafts, and transactions
- Add sync status and correction tools
- Import nflverse statistics with attribution

Acceptance: a real Sleeper league imports idempotently, scoring settings persist, and repeated syncs do not duplicate records.

### Phase 4 — My Team, Players, news, and rankings

- Build team analysis and player pages
- Add watchlists and news link model
- Build CSV/paste ranking import and player-name reconciliation
- Implement league-adjusted values and tiers

Acceptance: users can inspect their team, resolve import ambiguity, and understand how an adjusted value was calculated.

### Phase 5 — Research Desk and agent workflows

- Build and pair the local subscription-backed runner
- Add Codex SDK/app-server and Claude Code provider adapters
- Add research job states, owner approval, heartbeats, and offline queues
- Implement strict schemas, source persistence, validation, caching, and usage controls
- Add quick player, comparison, ranking explainer, and roster audit reports
- Create a small evaluation suite of representative questions

Acceptance: reports return after navigation/refresh, cite fresh sources, fail safely, and never exceed configured limits.

### Phase 6 — Draft Board

- Build cheat-sheet creation and ranking-source selection
- Implement tiers, VORP, scarcity, roster need, manual draft tracking, undo, and local resilience
- Add latest-insight side panel without blocking the draft UI

Acceptance: complete a simulated 15-round draft on desktop and mobile without losing state.

### Phase 7 — friend beta and hardening

- Invite a small test group
- Observe failed imports, confusing terms, slow reports, and usage cost
- Add admin usage dashboard, backups/exports, and restore procedure
- Fix accessibility, mobile, and draft-night performance issues

Acceptance: one week of friend use with no critical errors, no paid API activation, and understandable handling of subscription usage limits.

## 15. Verification strategy

### Automated

- Unit tests for scoring, VORP, ranking normalization, freshness, and player matching
- Adapter contract tests with saved sanitized fixtures
- API authorization and validation tests
- Research schema and citation validation tests
- Playwright tests for login, import, team, research, and draft flows
- axe checks on core pages
- Migration tests against an empty and populated D1 database

### Agent evaluations

- Correct player disambiguation
- Correct scoring-format interpretation
- Citation presence and source/date agreement
- Appropriate response to conflicting sources
- Stale-source rejection
- No unsupported injury conclusion
- Budget and tool-call limits honored

### Manual

- Desktop, narrow mobile, keyboard-only, and reduced-motion QA
- Simulated unreliable network during draft mode
- Real Sleeper league sync
- Cloudflare Access allow/deny test
- Subscription usage-limit and runner-offline behavior

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Ranking redistribution restrictions | User imports, source links, permission gate, and app-owned derived calculations |
| Agent hallucination | Structured evidence, citations, validation, confidence, and safe failure |
| Search cost grows unexpectedly | Hard cap, caching, batching, per-user limits, usage ledger |
| Provider changes IDs or schemas | Provider adapters, raw fixture tests, sync diagnostics |
| Draft-night network failure | Locally cached board and durable manual state |
| Local research runner is offline | Queue jobs, show runner health, and resume when it returns |
| Subscription reaches a usage limit | Stop cleanly, show reset guidance, and never auto-enable paid credits |
| A personal subscription becomes a shared backend | Owner approval for shared requests; each self-service user pairs their own subscription |
| Potato theme harms readability | Semantic tokens, restrained decoration, accessibility review |
| Free-tier behavior changes | Keep the deployment portable and monitor provider announcements |

## 17. Estimated delivery shape

For a greenfield project, the plan is approximately five to seven focused implementation phases after the design decision. A useful Sleeper-first private beta should arrive before Yahoo support, live draft integration, or exhaustive source coverage. Work should be released vertically so every phase leaves a usable product rather than a large unfinished platform.

## 18. Approved owner decisions

1. **Primary fantasy platform:** Sleeper
2. **League mode:** PPR redraft
3. **Visual direction:** Potato Bowl After Dark
4. **Research execution:** Local Codex/Claude subscription runner; paid model APIs disabled by default
5. **Friend access:** Explicit allowlisted email addresses through Cloudflare Access

Secondary questions that can wait until after the design prototype:

- Do you already pay for FantasyPros or another rankings provider and have an export/API entitlement?
- Is a free `workers.dev` address acceptable for the beta, or should the app use a custom domain?
- Which subscription should be the first runner provider: Codex, Claude, or whichever is already installed?
