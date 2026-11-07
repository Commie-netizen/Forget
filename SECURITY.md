# Security policy

## Report a vulnerability

Do **not** publish vulnerabilities in public issues. Use the repository's private security advisories (Security tab, "Report a vulnerability"). Include the version, reproduction steps, and impact. We aim to respond within 7 days.

Supported versions: the latest published release.

## Threat model

Forget is a local Windows app (Electron + Node server bound to `127.0.0.1` + SQLite).

Protections:

- No outbound network traffic in offline mode (default). With offline mode disabled: only `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com`, `media.discordapp.net`.
- The server listens only on loopback; the window loads only the local URL; external navigation, `window.open`, and permissions are denied.
- The token is never returned in plain text by the API (it is masked) and is sent only to Discord. It is encrypted at rest using Windows DPAPI (Electron `safeStorage`) when available.

Known limitations:

- An attacker who already has access to your Windows session can decrypt the DPAPI token.
- The local message archive is stored **in plain text** in the SQLite database.
- Local malware running with the user's permissions is outside the scope of this model.
- Using a user token (self-bot) violates Discord's terms of service; the user accepts this risk.

## Local server protections

The interface communicates with a server that listens only on `127.0.0.1`. A web page open in a browser can
send requests to this address; Forget rejects them:

- **DNS rebinding**: the `Host` header must specify a loopback address (`127.0.0.1`, `localhost`, `[::1]`).
- **CSRF**: a request with an `Origin` must come from the same origin; `Sec-Fetch-Site` must be
  `same-origin` or `none`; all writes require the `X-Forget-Request` header. No CORS headers are sent.
- **Headers**: strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, `DENY`.
- **Imported files**: ZIP archives read through the central directory, entries decompressed one at a time with limits
  (64 MB per file, 2 GB total); no archive path is written to disk.
- **CSV exports**: cells beginning with `= + - @` are neutralized (formula injection).

Malicious software already running under your Windows account remains outside this model: it can read the local database.

## Executable hardening

Electron fuses: no `RunAsNode` mode, `NODE_OPTIONS` and `--inspect` ignored, app loaded only from
`app.asar` with integrity checking, encrypted cookies. Windows: `contextIsolation`, `sandbox`, no `nodeIntegration`,
navigation and `window.open` blocked outside the intended domain, permissions denied. The Discord web session in the
login window is cleared as soon as the token has been retrieved.

## What is never collected

No telemetry, no crash reports, no background update checks (GitHub is contacted only when you click "Update", and the downloaded portable executable's SHA-256 is verified against `SHA256SUMS.txt` before replacing the current file on exit and restarting Forget), no accounts, no third-party services. The token is never automatically extracted from another app: it is entered by the user or obtained through an integrated login window with explicit consent.
