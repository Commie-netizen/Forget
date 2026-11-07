# Forget - desktop app (Electron)

Electron shell around the existing server (`server/`) and UI (`web/dist`).
The server is bundled by esbuild (no external Node dependencies in the asar) and
listens only on `127.0.0.1` (an available port chosen by the OS).

## Build

Prerequisites: Node 22+, `web/dist` already built (`npm run build` in `web/`), `server/node_modules` installed.

```
cd desktop
npm install
node build.mjs
```

Single output: `../dist-desktop/Forget-<version>.exe` (portable executable, electron-builder `portable` target).

Caches (Electron, electron-builder, temporary packaging files) are stored in `desktop/.cache/`
because some environments restrict writes to the workspace. Override with
`ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE`. No code signing; the icon embedded
in the exe is therefore not modified (`signAndEditExecutable: false`). The window icon is
applied at runtime.

`node make-icon.mjs` regenerates `assets/icon.ico` (256x256, #e5484d, letter R (icon kept unchanged for Forget)).

## Smoke test

Run from a copy outside the working directory (e.g. `%TEMP%`):

```
"Forget-<version>.exe" --smoke --smoke-out %TEMP%\forget-smoke.json
```

Writes `{ok, http:{health,root}, title, url, ...}`, then exits (code 0 on success, 1 otherwise, with the reason in the JSON).
The smoke test uses a disposable SQLite database in `%TEMP%`. If the `ELECTRON_RUN_AS_NODE` variable is
set in your shell, Electron behaves like Node ("bad option"): unset it before testing.

## Launching and removing

Run `Forget-<version>.exe` from any folder. At startup, it extracts itself into a temporary folder,
which is removed on exit. The first launch may be a little slower.
There is no installation, uninstaller, or shortcut creation. The executable is unsigned:
Windows SmartScreen may display a warning.

To remove Forget, close it and delete the `.exe` file. Data remains in
`%APPDATA%\forget-desktop\data\forget.sqlite`, and the Electron profile remains in `%APPDATA%\Forget`.
To remove everything, also manually delete the `%APPDATA%\forget-desktop` and `%APPDATA%\Forget` folders.

The **Update** button downloads `Forget-<version>.exe` from the latest GitHub release and verifies its SHA-256
with `SHA256SUMS.txt`. On exit, Forget replaces the `.exe` file currently in use, then restarts Forget.
A release contains exactly `Forget-<version>.exe` and `SHA256SUMS.txt`.

## Data and migration

Database: `%APPDATA%\forget-desktop\data\forget.sqlite` (use the `FORGET_DB_PATH` variable for another location).
`FORGET_APPDATA_DIR=<dossier>` overrides `%APPDATA%` (tests).
The smoke test JSON then includes `migrated` and `dbPath`.

## Security

Isolated context, sandbox, no nodeIntegration, external navigation and windows denied,
`webRequest` allows only `http://127.0.0.1:<port>`, all permissions denied,
single instance, no crash reporter; updates only when clicked (portable executable verified by SHA-256). `FORGET_DEV=1` enables DevTools (Ctrl+Shift+I).

## Splash (V5 C5)

At startup (except with `--smoke`), `main.js` opens a frameless 480x360 window (background `#0b0d10`) loaded
from `splash.html`: a light-colored block "FORGET" logo, 3 animated dots, rotating tips
("Purges continue in the background", ...). The HTML is loaded through a `data:` URL because the session's network
filter allows only `127.0.0.1`. The main window stays hidden until it has loaded,
then the splash closes (fallback: 15 s). No splash in `--smoke` mode.

## Integrated Discord login (V5 C1)

`globalThis.__FORGET_LOGIN_WINDOW` is defined before the server bundle is imported; the server route
`POST /api/discord/login-window` calls it. `openDiscordLogin()` opens a 520x760 modal window
(partition `persist:forget-discord-login`, `https://discord.com/login`, sandbox, contextIsolation,
nodeIntegration off, no preload, `window.open` denied, navigation limited to `discord.com` / `*.discord.com`).
When the URL is `discord.com/app` or `discord.com/channels/...`, it reads `localStorage.getItem('token')`
(on navigation events + polling every 1.5 s). Result: `{ token }` (window closed),
`{ cancelled: true }` if the user closes the window, `{ error }` if loading fails.
Listeners and the timer are cleaned up; only one login at a time. Nothing is read outside this window's localStorage.

## Token encryption (V5 C2)

Before `startServer`, if `safeStorage.isEncryptionAvailable()` (DPAPI on Windows),
`globalThis.__FORGET_CIPHER = { encrypt, decrypt }` (base64) is provided to the server, which stores the token
as `enc:v1:<base64>`. Otherwise, the server keeps it in plain text (`cipher: "plain"`).
Electron 45 marks these synchronous `safeStorage` APIs as deprecated (console warning, still functional).

## Test

Run `node build.mjs`, then, from a copy of `Forget-<version>.exe` in `%TEMP%` and without `ELECTRON_RUN_AS_NODE`:
`"Forget-<version>.exe" --smoke --smoke-out %TEMP%\forget-smoke.json`. The server port is chosen by the OS
(find it using `netstat -ano` with the PID of Forget.exe to test `/api/security` or `/api/discord/login-window`).
