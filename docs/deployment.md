# Checked Cloudflare deployments

The production Worker is deployed only after the same validation used locally succeeds:

```text
install -> typecheck -> UI tests -> Worker tests -> production build
        -> additive D1 migrations -> Worker deploy -> health smoke test
```

## Automatic deployments

`.github/workflows/verify-and-deploy.yml` runs on:

- pull requests to `main`: validation only;
- pushes to `main`: validation, remote migrations, deploy, and smoke test;
- manual workflow dispatch: the same checked deployment from the selected ref.

Add these GitHub Actions repository secrets under **Settings -> Secrets and variables -> Actions**:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Create a narrowly scoped Cloudflare token for the account that owns the Worker. It needs permission to deploy Workers and apply D1 migrations. Never commit the token or copy it into `wrangler.jsonc`.

The workflow becomes active after it is committed and pushed to GitHub. Git operations for this project should continue through Luna, as requested.

## Manual checked deployment

When Wrangler is already authenticated locally:

```bash
pnpm deploy
```

That command runs `pnpm check`, applies pending remote D1 migrations, and deploys. A failed validation stops before touching Cloudflare.

## Migration rule

Automatic migrations must be backward-compatible and additive. A destructive or breaking schema change should use a two-deploy sequence: add the new shape first, migrate/backfill safely, then remove the old shape in a later release. Wrangler captures a D1 backup before applying migrations and rolls back a migration that fails, but application compatibility still matters between the migration and Worker deployment.

## What is not automatic

Runtime secrets such as `IMPORT_ADMIN_TOKEN`, Yahoo OAuth credentials, `AGENT_RUNNER_TOKEN`, and `RESEARCH_OWNER_TOKEN` remain Cloudflare Worker secrets. The workflow does not print or replace them. Run `pnpm bridge:setup` once on the trusted runner computer to configure the two research-bridge secrets and create the gitignored `.env.runner`; rotate them deliberately if that file is lost or exposed.
