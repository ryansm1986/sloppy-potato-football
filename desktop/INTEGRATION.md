# Desktop shell integration

The files in this directory implement the Windows-first Electron shell without changing the existing web or runner builds. The shell serves the built Vite application from the secure `potato://app` origin, proxies `/api/*` to the configured Cloudflare Worker, and exposes only the typed commands in `shared/contracts.ts`.

## Dependency and package metadata additions

Add these development dependencies with the repository package manager:

```powershell
pnpm add -D electron electron-builder tsup cross-env concurrently wait-on
```

Add the following top-level package metadata to `package.json`:

```json
{
  "main": "dist-desktop/main/entry.js",
  "scripts": {
    "desktop:build:shell": "tsup desktop/main/entry.ts --format esm --platform node --external electron --out-dir dist-desktop/main && tsup desktop/preload.ts --format cjs --platform node --external electron --out-dir dist-desktop && node desktop/scripts/copy-assets.mjs",
    "desktop:build": "pnpm build && pnpm desktop:build:shell",
    "desktop:dev": "pnpm desktop:build:shell && concurrently -k \"vite\" \"wait-on http-get://127.0.0.1:5173 && cross-env SLOPPY_POTATO_DESKTOP_DEV_URL=http://127.0.0.1:5173 electron .\"",
    "desktop:test": "vitest run --config desktop/vitest.config.ts",
    "desktop:typecheck": "tsc -p desktop/tsconfig.json --pretty false",
    "desktop:pack": "pnpm desktop:build && electron-builder --win nsis portable",
    "desktop:dist": "pnpm desktop:typecheck && pnpm desktop:test && pnpm desktop:pack"
  },
  "build": {
    "appId": "com.sloppypotato.fantasyfootball",
    "productName": "Sloppy Potato Fantasy Football",
    "asar": true,
    "files": [
      "dist/client/**/*",
      "dist-desktop/**/*",
      "package.json"
    ],
    "directories": {
      "output": "release-desktop"
    },
    "win": {
      "target": ["nsis", "portable"]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

`electron-builder` merges `files` into the application ASAR. The Cloudflare Vite build's client output must remain at `dist/client/`; absolute `/assets/*` links work because `potato://app` is registered as a standard secure scheme. Add `dist-desktop/` and `release-desktop/` to `.gitignore`.

For a branded release, add a multi-resolution `desktop/assets/icon.ico` and set `build.win.icon` to that path. Until then the runtime tray uses the embedded fallback icon.

## Runner service hookup

`main/runner-controller.ts` is the integration seam. `main/existing-runner-adapter.ts` maps the repository's in-process runner controller into that interface and is the default used by `launchDesktopApp`. It can also be injected explicitly from `main/entry.ts` in tests or alternate hosts:

```ts
void launchDesktopApp({
  createRunnerController: (config) => new ExistingRunnerAdapter(config, app.getPath("userData")),
});
```

The adapter uses the in-process service—there is no runner child process—and emits its bounded, redacted status/log events. `pauseAfterCurrent` stops claiming new jobs but allows the active job to publish its result. `stop` preserves that same no-abort guarantee for a claimed job.

The desktop host starts the runner automatically when an encrypted runner token is present. Changing the API base URL after the in-process runner has started takes effect on the next application restart.

The fallback `UnavailableRunnerController` remains available for tests and builds that intentionally disable local research.

## Renderer hookup

Include `desktop/renderer-api.d.ts` in `tsconfig.app.json`, either by adding it to `include` or via a small type-only import. The React application can feature-detect desktop mode:

```ts
const desktop = window.sloppyPotatoDesktop;
const status = desktop ? await desktop.runner.status() : null;
const unsubscribe = desktop?.runner.onStatus(setRunnerStatus);
```

Listen to `window.sloppyPotatoDesktop.navigation.onRequest` and route the supplied path with React Router. This makes tray commands such as **Research schedules…** open the corresponding bundled page without granting the main process general navigation control.

Build a desktop settings panel around:

- `settings.get()` and `settings.update()` for close-to-tray, startup, notifications, and API endpoint preferences.
- `credentials.hasRunnerToken()`, `setRunnerToken()`, and `clearRunnerToken()`. This is the `AGENT_RUNNER_TOKEN`, and there is deliberately no credential-read method.
- `runner.start()`, `pauseAfterCurrent()`, `resume()`, `stop()`, `runNext()`, `status()`, and `logs()`.

## Security and release checklist

- The renderer uses `contextIsolation`, Chromium sandboxing, `webSecurity`, and no Node integration.
- All IPC calls validate their sender and reject unknown inputs. Permissions are denied by default; new windows are denied; only HTTP(S) links can open in the system browser.
- Credentials are encrypted by Electron `safeStorage` (Windows DPAPI) and saving fails if OS encryption is unavailable.
- Test an installed NSIS build as a standard Windows user, including launch-at-login, suspend/resume, close-to-tray, explicit quit, offline queue recovery, and upgrade/uninstall behavior.
- The startup registration supplies `--hidden`, so launch-at-login starts in the tray; verify this from an installed build because unpackaged Electron uses a different executable path.
- Code signing is strongly recommended before sharing installers. Configure `CSC_LINK` and `CSC_KEY_PASSWORD` only in the release environment; never commit either value.
- Auto-update is intentionally excluded from the MVP. Add it only after signed releases and a trusted update feed are available.
