# Checklist de publication (mainteneurs)

## Ne jamais committer

- Bases SQLite utilisateur : `*.sqlite*`, `data/`, `%APPDATA%\forget-desktop\`.
- Jetons, `.env`, clés, certificats, exports de sessions, captures contenant des données personnelles.
- Sorties de build : `dist/`, `dist-desktop/`, `build/`, `*.exe`, `*.blockmap`.
- `node_modules/`, journaux, notes de développement internes (`SPEC*.md`, `verify.mjs`, `packaging/`).

## Première publication : un dépôt neuf, sans historique

Publiez depuis un **nouveau** dépôt dont le premier commit contient l'état actuel du code. Ne poussez pas un
historique local antérieur : il peut contenir des fichiers ou des chemins qui n'ont pas vocation à être publics.

```bash
# depuis une COPIE propre du dossier du projet (sans .git)
git init -b main
git add .
git status                 # relire TOUTE la liste
git diff --cached --stat
```

Vérifications (les deux commandes ne doivent rien afficher) :

```bash
git ls-files | grep -iE "sqlite|\.env|\.exe|dist-desktop|node_modules|SPEC|verify\.mjs|packaging/"
git grep -iE "(token|secret|password|client_secret)\s*[:=]\s*['\"][A-Za-z0-9._-]{20,}"
```

Puis `git commit`, `git remote add origin <url>`, `git push -u origin main`.

## Réglages du dépôt GitHub

- Activer « Private vulnerability reporting », Dependabot alerts et Dependabot security updates.
- Protéger la branche `main` (revue obligatoire, pas de force-push) et limiter qui peut créer des tags `v*`.
- Actions : laisser les permissions par défaut en lecture seule ; seul le workflow Release demande `contents: write`.
- Les actions sont épinglées par SHA de commit : les mettre à jour volontairement (Dependabot peut le proposer).

## Releases

- Mettre la version partout (voir README, section « Publier une version ») et compléter `CHANGELOG.md`.
- `git tag vX.Y.Z` puis `git push origin vX.Y.Z` : le workflow `Release` publie `Forget-X.Y.Z.exe` et `SHA256SUMS.txt`.
- Le bouton « Mettre à jour » attend exactement ces deux fichiers dans la dernière release (non brouillon, non pré-release).
- Le SHA-256 protège contre un téléchargement corrompu ou altéré en transit, pas contre un compte GitHub compromis :
  protégez le compte (2FA, clé matérielle) et les tags.
