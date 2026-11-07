# Forget

![Version](https://img.shields.io/badge/version-4.3.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)
![License](https://img.shields.io/badge/license-MIT-green)
![Offline by default](https://img.shields.io/badge/network-offline%20by%20default-success)

A **100% local** Windows desktop app for cleaning up **your own history**: Discord messages, X and Reddit posts,
TikTok reposts, and data broker scans. No telemetry, **offline by default**.

An independent project, unaffiliated with Discord, X, Reddit, TikTok, Meta, or any other service.

## Warnings

- **Terms of service**: automating a Discord account with a user token (self-bot) violates Discord's terms of service.
  TikTok repost removal uses the site's undocumented web requests within your session. This may also violate
  TikTok's terms of service and stop working without notice. Your account could be suspended. Use at your own risk.
- **Irreversible**: deletions cannot be undone on the platforms. Forget archives text locally before each action,
  but does not archive media.
- The software is provided "as is" (see [LICENSE](LICENSE)). Use Forget only on **your own accounts**.

## Features

| Platform | Connection | What Forget does |
|---|---|---|
| Discord | Your token (entered manually or through a login window with your consent) | Search, mouse selection (Shift+click), bulk deletion/editing, "all search results", entire conversations, date ranges, scheduled purges with no cap, disappearing messages mode, Discord export import |
| X (Twitter) | OAuth 2.0 PKCE with **your** app, or a token | Paginated loading, filters, selection of up to 500 items, API deletion |
| Reddit | OAuth ("installed" app) with **your** Client ID, or a token | Posts and comments, filters, API deletion |
| TikTok | Your session in an isolated window | Repost inventory, filters, paced removal with automatic pauses |
| Facebook, Instagram | Isolated official window | Assisted cleanup (you click in the official interface) |
| Data brokers | Local | Catalog of 97 brokers, scans, removal requests (demo adapters) |

Shared safeguards: preview before deletion, typed confirmation (`DELETE`, `EDIT`, or `REMOVE`, depending on the action),
a 5 s grace period, protections (pinned messages and words to never touch), local archive before each action,
pause/resume/stop, and respect for rate limits (429).

## Installation

Windows 10/11 x64. Download `Forget-<version>.exe` from [Releases](../../releases), optionally verify its SHA-256
checksum with `SHA256SUMS.txt`, then run it from any folder.
Forget is a single portable executable. At startup, it extracts itself into a temporary folder,
which is removed on exit. The first launch may be a little slower.
There is no installation, uninstaller, or shortcut creation. The executable is unsigned:
Windows SmartScreen may display a warning.

To uninstall Forget, close it and delete the `.exe` file. Data remains in
`%APPDATA%\forget-desktop\data\forget.sqlite`, and the Electron profile remains in `%APPDATA%\Forget`.
To remove everything, also manually delete the `%APPDATA%\forget-desktop` and `%APPDATA%\Forget` folders.

## Updates

Click **Update** (sidebar) or open **Settings → Updates**. Forget contacts GitHub only
when you click. It downloads `Forget-<version>.exe` from the latest GitHub release and verifies its SHA-256
with `SHA256SUMS.txt`. When Forget closes, it replaces the `.exe` file currently in use with the new
version, then restarts Forget. For a locally built version, first enter the repository as
`owner/repository` on the same screen.

## Connect X or Reddit (OAuth)

Forget does not provide API credentials: you create your own app.

1. **X**: at developer.x.com, create a *Native App* (public client), enable OAuth 2.0, and register
   the redirect URL `http://127.0.0.1:53682/forget/callback` (or your own). Endpoint access depends on your X API plan.
   **Reddit**: at reddit.com/prefs/apps, create an *installed app* with the same redirect URL.
2. **Settings → Privacy**: disable offline mode.
3. Open the platform in Forget, paste the **Client ID**, check the redirect URL, click
   **Sign in with…**, and authorize access on the official page. Forget intercepts the redirect: nothing listens on that port.

Requested permissions: X `tweet.read tweet.write users.read offline.access`; Reddit `identity history read edit`
(permanent duration for automatic renewal).

## TikTok: remove your reposts

TikTok does not offer an official repost API. Forget opens `tiktok.com` in an isolated window: you sign in
yourself (Forget reads neither your password nor your cookies). Then: **Check session** → **Start inventory**
→ filter and select → **Remove**. One request at a time, with an adjustable fixed interval (4 s by default). If a request is rejected,
Forget pauses for 15 min before retrying and stops after 3 consecutive rejections (try again an hour later).

## Privacy

| Control | Status |
|---|---|
| Server | Listens only on `127.0.0.1` |
| Main window | Loads only the local URL; external navigation, `window.open`, and permissions are denied |
| Network | **No outbound traffic** while offline mode is enabled (default) |
| Offline mode disabled | Explicit hosts: Discord, `api.x.com`, `oauth.reddit.com`, `www.reddit.com` (OAuth), GitHub (updates, only when clicked) |
| TikTok / Meta / OAuth windows | Separate sessions, no Node access, navigation restricted to the service's domain, opened at your request |
| Telemetry, crash reporter | None |
| Tokens | Encrypted at rest using Windows DPAPI (Electron `safeStorage`) when available, never returned by the API |
| Data | Local SQLite database `%APPDATA%\forget-desktop\data\forget.sqlite` (message archive in plain text) |

## Development

Prerequisite: Node.js 22.13 or later (`node:sqlite` module).

```bash
npm run install:all      # server + web + desktop dependencies
npm run build            # web interface (Vite)
npm start                # build, then local server http://127.0.0.1:4173
npm run dev:web          # interface with hot reloading
npm run desktop:build    # dist-desktop/Forget-<version>.exe
npm run test:all         # all test suites
```

Architecture: `server/` (local Hono API, SQLite, Discord / X / Reddit / TikTok engines, network lock, updates),
`web/` (React + Vite), `desktop/` (Electron: isolated windows, hardening, electron-builder build).

## Publish a release

1. Set the same version number in `package.json`, `server/package.json`, `web/package.json`, `desktop/package.json`,
   `server/src/version.mjs`, and `web/src/lib.js`, then add the corresponding section to [CHANGELOG.md](CHANGELOG.md).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`: the **Release** workflow runs tests, builds, computes `SHA256SUMS.txt`, and
   publishes the release with exactly `Forget-<version>.exe` and `SHA256SUMS.txt`. The repository name is embedded in the app for the update button.

## Security and contributions

[SECURITY.md](SECURITY.md) (private reporting), [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE), copyright Forget contributors.
