# Release notes

Format: one section per version, newest first. The release workflow publishes the text from the section
matching the tag (`v4.3.0` → `## 4.3.0`).

## Unreleased

### Changed
- License: PolyForm Noncommercial 1.0.0 replaces MIT. Commercial use and sale are not allowed, and every
  copy must keep the license and the `Required Notice` crediting the authors.

## 4.3.0

### Added
- A single file: the portable `Forget-<version>.exe` replaces the installer; updates replace this file and restart Forget.
- **Update button** (sidebar and Settings → Updates): checks the latest GitHub release on demand,
  downloads the portable executable, verifies its SHA-256 against the release's `SHA256SUMS.txt` file,
  then replaces the file on exit and restarts Forget.
  No automatic background checks.
- **TikTok: repost removal**. Full inventory of your reposts from your own web session,
  filters (description, author), selection (Shift+click for a range), local archive before each removal,
  adjustable fixed interval (2 to 60 s), pause/resume/stop, 15 min cooldown on rejection, stop after 3 rejections.
- **X and Reddit OAuth login**: "Sign in with…" button using *your* app's Client ID
  (PKCE S256 for X, "installed" app for Reddit). Automatic token renewal (refresh token).
  Manual token entry remains available.
- **Discord: new ways to delete**:
  - "All search results" scope (content + dates, within a channel or an entire server);
  - protections: keep pinned messages, only messages with attachments, words to never touch;
  - preview before deletion (estimate and examples, a single search, no action);
  - 5 s grace period after confirmation, with "Cancel" and "Start now";
  - Shift+click to select a range, "Invert page selection".
- X/Reddit: exclusion filter, invert selection, Shift+click.

### Security
- Local server protected against malicious websites: removed permissive CORS (a website could read
  the archive), blocked DNS rebinding (`Host`) and CSRF (`Origin`, `Sec-Fetch-Site`, `X-Forget-Request` header).
- Security headers and strict CSP; external links restricted to `http(s)`.
- ZIP imports with bounded memory usage (skipped entries are no longer kept in memory), ZIP bombs blocked.
- CSV exports protected against formula injection; editing regular expressions limited to 500 characters.
- Electron fuses (no RunAsNode, NODE_OPTIONS, or --inspect; app.asar integrity; encrypted cookies).
- Discord web session cleared after token retrieval.
- `@hono/node-server` 2.1.6 (security advisories addressed); GitHub actions pinned by SHA, `persist-credentials: false`.
- New test: `npm run test:security`.

### Fixed
- Scheduled purges: the "Fast" speed setting was ignored (always "Safe").
- `PATCH /api/settings` can no longer write reserved keys (`privacy.*`, `discord.*`, `update.*`…).
- Server version displayed as 4.0.0 instead of the actual version.

### Performance
- SQLite statements prepared once (cached) in the Discord module and network lock.
- Facebook/Instagram windows: offline status is no longer read from the database for every resource loaded.
- Channels from all Discord servers loaded in parallel (controlled by the rate limiter).
- Interface: no refresh while the window is hidden; no re-render if data has not changed.

### Technical
- Single version source in `server/src/version.mjs`.
- Portable executable named `Forget-<version>.exe`.
- New test: `npm run test:v43`; `npm run test:all` runs all suites.

## 4.2.0
- Twitter/X and Reddit pages (user OAuth token, paginated loading, selection, archive, API deletion).
- Assisted cleanup for Facebook and Instagram (isolated official window).
- Import a Discord export (ZIP, folder) or a Forget Engine database, purge using a plan.

## 4.1.0
- Discord rate limiter shared per token, global operations banner.

## 4.0.0
- First public release of Forget.
