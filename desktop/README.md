# Sloppy Potato desktop shell

## Google access

When Google access is enabled on the Worker, desktop sign-in opens the system browser. After Google sign-in, explicitly confirm the computer in that browser and return to the app. The handoff can be cancelled or restarted and expires after at most ten minutes. Google credentials never enter the desktop renderer; only an opaque, revocable app session is stored using OS-protected encryption, separately from the runner credential.

`window.sloppyPotatoDesktop.auth` exposes `status()`, `signIn()`, `cancel()` and `signOut()` without tokens. The packaged API proxy supplies the app session only to the configured origin, never to machine-runner endpoints, and rejects redirects. Owner enrollment uses the signed-in owner session automatically; viewer/researcher accounts cannot manage local runner controls, credentials, startup or API destination settings. Each privileged action verifies the current role with the server. Already configured unattended runners continue with their separate machine credential when a user signs out.

Changing the API origin stops the local runner and removes local app/runner credentials; reconnect the computer to the new server. App sign-out alone does not remove or revoke its machine credential. Production Google authentication should be tested in the packaged `potato://app` shell: the Vite localhost development renderer does not use the packaged API proxy.

This directory contains a secure Electron host for the existing Vite UI and an injectable desktop runner service. It is Windows-first and designed to live in the notification area after its window closes.

Implemented shell behavior:

- single-instance window with close-to-tray and explicit quit;
- tray status and runner actions, schedule navigation, and Windows startup toggle;
- locally bundled UI on a secure custom protocol with a narrow Cloudflare API proxy;
- sandboxed renderer, denied permission requests, restricted navigation, and typed IPC;
- DPAPI-backed runner-token persistence through Electron `safeStorage`;
- job-completion/error notifications; and
- one-click, owner-authorized per-device enrollment whose one-time token is encrypted by Windows DPAPI;
- an in-process adapter for the existing Codex runner with terminal bad-token recovery and safe replace/remove controls; and
- opt-in download and restart installation from the public GitHub Releases feed for installed NSIS builds.

Once configured, the runner starts with the desktop host so cloud-scheduled work can be picked up while the app remains in the tray.

Auto-update is intentionally unavailable in development and portable builds. A packaged NSIS installation discovers a newer semver release automatically, but the user chooses when to download and when to restart. The release workflow and operator steps are documented in [INTEGRATION.md](./INTEGRATION.md#desktop-release-and-update-feed).

See [INTEGRATION.md](./INTEGRATION.md) for exact package scripts, packaging metadata, and runner/renderer wiring steps.
