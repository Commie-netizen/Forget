# Publishing checklist (maintainers)

## Never commit

- User SQLite databases: `*.sqlite*`, `data/`, `%APPDATA%\forget-desktop\`.
- Tokens, `.env`, keys, certificates, session exports, screenshots containing personal data.
- Build output: `dist/`, `dist-desktop/`, `build/`, `*.exe`, `*.blockmap`.
- `node_modules/`, logs, internal development notes (`SPEC*.md`, `verify.mjs`, `packaging/`).

## First publication: a fresh repository with no history

Publish from a **new** repository whose first commit contains the current code. Do not push
older local history: it may contain files or paths that are not intended to be public.

```bash
# from a clean COPY of the project folder (without .git)
git init -b main
git add .
git status                 # review the ENTIRE list
git diff --cached --stat
```

Checks (both commands should produce no output):

```bash
git ls-files | grep -iE "sqlite|\.env|\.exe|dist-desktop|node_modules|SPEC|verify\.mjs|packaging/"
git grep -iE "(token|secret|password|client_secret)\s*[:=]\s*['\"][A-Za-z0-9._-]{20,}"
```

Then `git commit`, `git remote add origin <url>`, `git push -u origin main`.

## GitHub repository settings

- Enable "Private vulnerability reporting", Dependabot alerts, and Dependabot security updates.
- Protect the `main` branch (required review, no force-push) and restrict who can create `v*` tags.
- Actions: keep default permissions read-only; only the Release workflow requests `contents: write`.
- Actions are pinned by commit SHA: update them deliberately (Dependabot can suggest updates).

## Releases

- Set the version everywhere (see the README's "Publish a release" section) and update `CHANGELOG.md`.
- `git tag vX.Y.Z` then `git push origin vX.Y.Z`: the `Release` workflow publishes `Forget-X.Y.Z.exe` and `SHA256SUMS.txt`.
- The "Update" button expects exactly these two files in the latest release (not a draft or prerelease).
- SHA-256 protects against downloads that are corrupted or tampered with in transit, not a compromised GitHub account:
  protect the account (2FA, hardware key) and tags.
