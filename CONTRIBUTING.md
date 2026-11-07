# Contribuer à Forget

Merci de votre intérêt. Merci de lire le [Code de conduite](CODE_OF_CONDUCT.md).

## Prérequis

- Windows 10/11, Node.js 22, npm.

## Mise en place

```bash
git clone <url-du-depot>
cd <dossier>
npm run install:all     # server, web, desktop
npm run build           # compile l'interface web
npm run serve           # serveur local
```

## Conventions

- ESM (`.mjs`), indentation 2 espaces, LF (voir `.editorconfig`).
- Changements ciblés : une PR, un sujet. Pas de refactor non lié.
- Aucune sortie réseau ajoutée en dehors du verrou hors-ligne (`npm run test:privacy` doit rester vert).
- Pas de télémétrie, pas d'appel vers des services tiers.
- Ne jamais committer de token, de base SQLite, de log ni de contenu personnel (voir `PUBLISHING.md`).

## Tests obligatoires

Avant toute PR, ces commandes doivent passer :

```bash
npm test
npm run test:discord
npm run test:privacy
npm run build
```

Toute nouvelle fonctionnalité ou correction ajoute ou adapte un test. `npm run verify` est recommandé pour les changements de bout en bout.

## Pull requests

1. Forkez et créez une branche (`feat/...`, `fix/...`).
2. Messages de commit clairs (Conventional Commits appréciés).
3. Remplissez le modèle de PR et cochez la checklist.
4. La CI (build Windows) doit être verte.

## Contributing (English)

Node 22, `npm run install:all`, keep the four commands above green, add tests for new behavior, never commit secrets or user data, keep the app offline by default with no telemetry.
