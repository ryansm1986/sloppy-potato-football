# Google sign-in setup and handoff

First release: **v0.1.12**. Production configuration now selects `AUTH_MODE=google`; deployment requires the owner's Google OAuth credentials. Adding the migration or installing the desktop release alone does not make a workspace invite-only. Missing `AUTH_MODE`, or `AUTH_MODE=legacy`, preserves the previous legacy behavior and owner-token access. Do not change a private deployment back to legacy as a troubleshooting shortcut.

Owner account: **therealryansmith@gmail.com**.

## 1. Create the Google OAuth client

Use [Google Cloud Console](https://console.cloud.google.com/) to create or select a project for Sloppy Potato. In Google Auth Platform (or APIs & Services → OAuth consent screen/Credentials, depending on the Console layout):

1. Set the app name to **Sloppy Potato Fantasy Football**. Use an owner-controlled support/contact email.
2. Choose an **External** audience for personal Gmail accounts and friends outside one Workspace organization. Keep the app in **Testing** initially. Add `therealryansmith@gmail.com` and your intended friends under test users where offered.
3. Request only the basic identity scopes: `openid`, `email`, and `profile`. Do not add Gmail, Drive, Calendar, or other data-access scopes.
4. Create an OAuth client with application type **Web application**, not Desktop app. The Cloudflare Worker exchanges the authorization code and holds the client secret. Both the website and desktop handoff use this server-side client.
5. Add this exact **Authorized redirect URI**, with no trailing slash:

   ```text
   https://sloppy-potato-fantasy-football.therealryansmith.workers.dev/api/auth/google/callback
   ```

   The homepage is:

   ```text
   https://sloppy-potato-fantasy-football.therealryansmith.workers.dev/
   ```

   This implementation uses server redirects, not the browser Google JavaScript SDK, so an Authorized JavaScript origin is not needed for the implemented flow. Never register `potato://app` as the Google redirect; Google returns to the HTTPS Worker.

Google documents the server client and exact redirect matching in its [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and the identity scopes in its [OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

Google currently makes an exception to its Testing allowlist restriction for apps requesting only basic identity scopes. **Google's test-user list is not our access-control boundary:** Sloppy Potato checks its own invitations after Google verifies identity. See [Google's OAuth app-state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

Only Gmail/Googlemail or Google Workspace accounts are accepted by this implementation. A Google account created with a third-party consumer email is not sufficient: Google may not remain authoritative for that mailbox's ownership. This restriction follows the identity distinction described in [Google's backend authentication guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## 2. Store credentials privately in Cloudflare

From the trusted project folder, with Wrangler authenticated to the correct Cloudflare account, run these separately and paste each value into its interactive prompt:

```powershell
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
```

```powershell
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

Do not paste the values into chat, place them in source code, commit downloaded client JSON, or put secrets directly in a shell command. The client secret belongs only on the Worker. No Google client secret or Google access/refresh token is installed in the desktop app.

When preparing activation, add or verify these non-secret Worker variables in `wrangler.jsonc`. Keep the mode `legacy` until the deliberate activation step:

```json
"vars": {
  "AUTH_MODE": "legacy",
  "APP_BASE_URL": "https://sloppy-potato-fantasy-football.therealryansmith.workers.dev",
  "OWNER_GOOGLE_EMAIL": "therealryansmith@gmail.com"
}
```

`APP_BASE_URL` must be the HTTPS origin only: no callback path, query, credentials, or fragment. Keep the configured owner email stable; ordinary account-management controls cannot change, demote, or revoke the owner.

## 3. Deliberately activate invite-only mode

1. Deploy the tested v0.1.12 code and additive migrations, and install desktop v0.1.12 or newer on computers you will use. Older desktop versions cannot complete the new sign-in handoff.
2. Verify both Google secrets and the non-secret variables above are configured. While mode remains legacy, `GET /api/auth/session` can report `configured: true`, but Google sign-in is intentionally disabled. Credential presence is not an activation switch.
3. Change only the planned mode value to `"AUTH_MODE": "google"`, then use the checked deployment command:

   ```powershell
   pnpm deploy
   ```

   This runs the project's checks, applies pending remote migrations, and deploys. Configuration and deployment changes should follow the project's normal reviewed workflow; git work remains delegated to Luna.

4. Open the website in a fresh browser session and sign in as **therealryansmith@gmail.com**. Verify Settings shows the **owner** role. The first verified sign-in binds that email to its Google account identity.
5. In a separate signed-out browser, confirm the app shows only the sign-in screen. Protected data requests, such as `/api/players?limit=1`, should return `401`; `/api/auth/session` remains a public status endpoint and should report `mode: "google"`, `configured: true`, and `authenticated: false` when signed out.
6. Add one test friend in Settings and verify their role before inviting the rest of the group. Test desktop sign-in and owner runner enrollment as described below.

Google mode with missing or invalid configuration fails closed. An invalid explicitly supplied mode also fails closed rather than reopening the app. Do not switch back to legacy just to bypass a sign-in problem: **that restores the previous, non-invite-only access model**. Repair the callback, secrets, or origin through the trusted Cloudflare deployment account. Keep that administrative access available during first activation.

## 4. Invite friends and manage permissions

Use **Settings → People & permissions** after signing in as owner. Adding an email creates app access; it does **not** send an invitation email. Share the website URL yourself. Invite the exact Gmail/Workspace address the friend will select during sign-in.

| Role | Permissions |
| --- | --- |
| Viewer — default | Read shared research/results and manage their own rankings and publisher preferences. |
| Researcher | Viewer access plus queue/retry research and manage research schedules. These jobs can use your connected computers and subscription capacity. |
| Owner | Researcher access plus user permissions, agent settings/dashboard, local runner controls/enrollment, and global publisher management/blocks. |

Personal rankings and publisher preferences use separate account identities. Research jobs, schedules, and published research are shared small-group resources; granting researcher access is permission to use the group's research queue, not a private runner allocation.

App sessions last **seven days**. This is Sloppy Potato's session lifetime, not a dependency on Google's Testing refresh-token rules; the app does not request ongoing Google API access. Signing out revokes that app session. Changing a member's role or revoking access invalidates their existing browser and desktop sessions; restoring access requires signing in again. The configured owner is protected from ordinary demotion/revocation.

## 5. Sign in from the desktop app

1. Install desktop **v0.1.12 or newer** and select **Sign in with Google**.
2. Complete Google sign-in in your normal system browser.
3. On the returned Sloppy Potato page, check the displayed email and select **Confirm this computer** only if you initiated sign-in from your own desktop app.
4. Return to the desktop app. It polls for approval and connects automatically. Cancel/restart is available; a handoff expires after at most ten minutes.

The browser flow is intentional: Google does not allow OAuth inside an embedded app browser. See [Google's OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

The desktop receives only an opaque, revocable Sloppy Potato session. The main process encrypts it using the operating system's credential protection and never sends it to the renderer. It is bound to the configured API origin. The packaged proxy attaches it to app API requests, excludes machine-runner endpoints, and rejects redirects that could leak credentials.

Test this with the packaged **`potato://app` shell**. The current `desktop:dev` Vite/localhost renderer does not use that packaged authenticated API proxy and is not supported for end-to-end Google authentication testing.

### Runner credentials remain separate

- A signed-in owner can set up/enroll this computer without copying an owner token into the desktop form.
- Viewer and researcher sessions cannot start, stop, reconfigure, or enroll a local runner. Main-process controls verify the current role with the server, not just a UI flag.
- A previously enrolled unattended runner can continue using its independent machine credential after app sign-out or session expiry. App sign-out does not revoke the computer's runner credential.
- To disable a computer, explicitly revoke its runner credential using the owner controls. To remove its local setup, use the runner settings controls while signed in as owner.
- Changing the configured API origin stops the local runner and removes local app/runner credentials to avoid sending them to a different server; reconnect afterwards.

## Troubleshooting

- **`redirect_uri_mismatch`:** check the Web application's exact redirect URI above, including HTTPS, hostname and `/api/auth/google/callback`; confirm the client ID and secret belong to that same client.
- **Google sign-in awaiting configuration:** check both Worker secrets, `APP_BASE_URL`, and the deliberate `AUTH_MODE=google` deployment. Never solve this by publishing secrets in the UI or repository.
- **Invite required:** select the configured owner account or ask the owner to add the exact email. Adding a Google Console test user does not create a Sloppy Potato invitation.
- **Google-managed email required:** use Gmail/Googlemail or a Google Workspace account, not a third-party consumer email registered as a Google account.
- **Desktop stays waiting:** finish the browser's separate **Confirm this computer** step, then return to the app. If the flow expired, cancel and start again. Updating an older desktop build may be required.
- **Controls report that access could not be verified:** reconnect to the API and sign in again. Local runner mutations fail closed while the current owner role cannot be verified; existing unattended work has separate machine authorization.
- **Google asks for domain ownership you do not have:** do not claim ownership of `workers.dev`. If the Console requires branding/domain verification incompatible with the assigned Worker address, use a custom domain you control and update both `APP_BASE_URL` and the registered callback consistently. Only use domains you own or are authorized to use, per [Google's OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

Live Google consent, owner sign-in, and desktop browser approval cannot be verified until the owner configures real credentials. Passing automated tests is not a claim that this external setup has been completed.
