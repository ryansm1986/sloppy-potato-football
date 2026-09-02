# Sloppy Potato desktop shell

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
