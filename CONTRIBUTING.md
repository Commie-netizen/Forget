# Contributing to Forget

Thank you for your interest. Please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Windows 10/11, Node.js 22, npm.

## Setup

```bash
git clone https://github.com/Commie-netizen/Forget.git
cd <dossier>
npm run install:all     # server, web, desktop
npm run build           # compile the web interface
npm run serve           # local server
```

## Conventions

- ESM (`.mjs`), 2-space indentation, LF (see `.editorconfig`).
- Focused changes: one PR, one topic. No unrelated refactoring.
- No outbound network traffic added outside the offline lock (`npm run test:privacy` must keep passing).
- No telemetry, no calls to third-party services.
- Never commit tokens, SQLite databases, logs, or personal content (see `PUBLISHING.md`).

## Required tests

Before any PR, these commands must pass:

```bash
npm test
npm run test:discord
npm run test:privacy
npm run build
```

Every new feature or fix must add or update a test. `npm run verify` is recommended for end-to-end changes.

## Pull requests

1. Fork the repository and create a branch (`feat/...`, `fix/...`).
2. Write clear commit messages (Conventional Commits welcome).
3. Fill in the PR template and complete the checklist.
4. CI (Windows build) must pass.

## Contributing summary

Node 22, `npm run install:all`, keep the four commands above passing, add tests for new behavior, never commit secrets or user data, keep the app offline by default with no telemetry.

## License of contributions

By submitting a contribution, you agree that it is released under the project's license,
[PolyForm Noncommercial 1.0.0](LICENSE), and that you are added to the "Forget contributors" credited
in the Required Notice.
