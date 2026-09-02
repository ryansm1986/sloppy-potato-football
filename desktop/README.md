# Sloppy Potato desktop shell

This directory contains a secure Electron host for the existing Vite UI and an injectable desktop runner service. It is Windows-first and designed to live in the notification area after its window closes.

Implemented shell behavior:

- single-instance window with close-to-tray and explicit quit;
- tray status and runner actions, schedule navigation, and Windows startup toggle;
- locally bundled UI on a secure custom protocol with a narrow Cloudflare API proxy;
- sandboxed renderer, denied permission requests, restricted navigation, and typed IPC;
- DPAPI-backed runner-token persistence through Electron `safeStorage`;
- job-completion/error notifications; and
- an in-process adapter for the existing Codex runner, activated only after a valid encrypted runner token is provided.

Once configured, the runner starts with the desktop host so cloud-scheduled work can be picked up while the app remains in the tray.

See [INTEGRATION.md](./INTEGRATION.md) for exact package scripts, packaging metadata, and runner/renderer wiring steps.
