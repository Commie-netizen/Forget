# Forget - application de bureau (Electron)

Coquille Electron autour du serveur existant (`server/`) et de l'UI (`web/dist`).
Le serveur est bundle par esbuild (aucune dependance Node externe dans l'asar) et
ecoute uniquement sur `127.0.0.1` (port libre choisi par l'OS).

## Build

Prerequis : Node 22+, `web/dist` deja construit (`npm run build` dans `web/`), `server/node_modules` installe.

```
cd desktop
npm install
node build.mjs
```

Sortie unique : `../dist-desktop/Forget-<version>.exe` (exécutable portable, cible electron-builder `portable`).

Les caches (Electron, electron-builder, fichiers temporaires de packaging) sont dans `desktop/.cache/`
car certains environnements confinent les ecritures au workspace. Surcharge possible via
`ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE`. Pas de signature de code ; l'icone embarquee
dans l'exe n'est donc pas modifiee (`signAndEditExecutable: false`), l'icone de fenetre est
appliquee a l'execution.

`node make-icon.mjs` regenere `assets/icon.ico` (256x256, #e5484d, lettre R (icone conservee telle quelle pour Forget)).

## Test (smoke)

Lancer depuis une copie hors du dossier de travail (ex. `%TEMP%`) :

```
"Forget-<version>.exe" --smoke --smoke-out %TEMP%\forget-smoke.json
```

Ecrit `{ok, http:{health,root}, title, url, ...}` puis quitte (code 0 si ok, 1 sinon, raison dans le JSON).
Le smoke utilise une base SQLite jetable dans `%TEMP%`. Si la variable `ELECTRON_RUN_AS_NODE` est
definie dans votre shell, Electron se comporte comme Node ("bad option") : la supprimer avant le test.

## Lancement et suppression

Lancez `Forget-<version>.exe` depuis n'importe quel dossier. Il s'extrait au démarrage dans un dossier temporaire,
supprimé à la fermeture. Le premier lancement peut être un peu plus lent.
Aucune installation, aucun désinstalleur et aucun raccourci créé. L'exécutable n'est pas signé :
Windows SmartScreen peut afficher un avertissement.

Pour supprimer Forget, fermez-le puis supprimez le fichier `.exe`. Les données restent dans
`%APPDATA%\forget-desktop\data\forget.sqlite` et le profil Electron dans `%APPDATA%\Forget`.
Pour tout effacer, supprimez aussi manuellement les dossiers `%APPDATA%\forget-desktop` et `%APPDATA%\Forget`.

Le bouton **Mettre à jour** télécharge `Forget-<version>.exe` de la dernière release GitHub et vérifie son SHA-256
avec `SHA256SUMS.txt`. À la fermeture, Forget remplace le fichier `.exe` en cours d'utilisation, puis relance Forget.
Une release contient exactement `Forget-<version>.exe` et `SHA256SUMS.txt`.

## Donnees et migration

Base : `%APPDATA%\forget-desktop\data\forget.sqlite` (variable `FORGET_DB_PATH` pour un autre emplacement).
`FORGET_APPDATA_DIR=<dossier>` remplace `%APPDATA%` (tests).
Le JSON du smoke contient alors `migrated` et `dbPath`.

## Securite

Contexte isole, sandbox, pas de nodeIntegration, navigation et fenetres externes refusees,
`webRequest` n'autorise que `http://127.0.0.1:<port>`, toutes permissions refusees,
mono-instance, pas de crash reporter ; mise a jour uniquement sur clic (exécutable portable vérifié par SHA-256). `FORGET_DEV=1` active les DevTools (Ctrl+Maj+I).

## Splash (V5 C5)

Au lancement (hors `--smoke`), `main.js` ouvre une fenetre frameless 480x360 (fond `#0b0d10`) chargee
depuis `splash.html` : logo « FORGET » en bloc clair, 3 points animes, astuces rotatives
(« Les purges continuent en arriere-plan », ...). Le HTML est charge en URL `data:` car le filtre reseau
de la session n'autorise que `127.0.0.1`. La fenetre principale reste cachee jusqu'a son chargement,
puis le splash est ferme (fallback : 15 s). Pas de splash en mode `--smoke`.

## Connexion Discord integree (V5 C1)

`globalThis.__FORGET_LOGIN_WINDOW` est defini avant l'import du bundle serveur ; la route serveur
`POST /api/discord/login-window` l'appelle. `openDiscordLogin()` ouvre une fenetre modale 520x760
(partition `persist:forget-discord-login`, `https://discord.com/login`, sandbox, contextIsolation,
nodeIntegration off, sans preload, `window.open` refuse, navigation limitee a `discord.com` / `*.discord.com`).
Quand l'URL est `discord.com/app` ou `discord.com/channels/...`, on lit `localStorage.getItem('token')`
(sur evenements de navigation + sondage 1,5 s). Resultat : `{ token }` (fenetre fermee),
`{ cancelled: true }` si l'utilisateur ferme la fenetre, `{ error }` si le chargement echoue.
Listeners et timer sont nettoyes ; un seul login a la fois. Aucune lecture hors du localStorage de cette fenetre.

## Chiffrement du token (V5 C2)

Avant `startServer`, si `safeStorage.isEncryptionAvailable()` (DPAPI sous Windows),
`globalThis.__FORGET_CIPHER = { encrypt, decrypt }` (base64) est fourni au serveur, qui stocke le token
sous la forme `enc:v1:<base64>`. Sinon le serveur reste en clair (`cipher: "plain"`).
Electron 45 signale ces API `safeStorage` synchrones comme deprecated (avertissement console, fonctionnel).

## Test

`node build.mjs` puis, depuis une copie de `Forget-<version>.exe` dans `%TEMP%` et sans `ELECTRON_RUN_AS_NODE` :
`"Forget-<version>.exe" --smoke --smoke-out %TEMP%\forget-smoke.json`. Le port du serveur est choisi par l'OS
(trouver-le via `netstat -ano` sur le PID de Forget.exe pour tester `/api/security` ou `/api/discord/login-window`).
