# Forget

![Version](https://img.shields.io/badge/version-4.3.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)
![License](https://img.shields.io/badge/license-MIT-green)
![Offline by default](https://img.shields.io/badge/network-offline%20by%20default-success)

Application de bureau Windows **100 % locale** pour nettoyer **votre propre historique** : messages Discord, publications
X et Reddit, republications TikTok, et scans de data brokers. Aucune télémétrie, **hors-ligne par défaut**.

Projet indépendant, sans affiliation avec Discord, X, Reddit, TikTok, Meta ni aucun autre service.

## Avertissements

- **Conditions d’utilisation** : automatiser un compte Discord avec un token utilisateur (self-bot) viole les CGU de Discord.
  Le retrait des reposts TikTok passe par les requêtes web non documentées du site, dans votre session : cela peut aussi
  enfreindre les CGU de TikTok et cesser de fonctionner sans préavis. Risque de suspension : utilisation à vos risques.
- **Irréversible** : les suppressions ne peuvent pas être annulées sur les plateformes. Forget archive localement le texte
  avant chaque action, pas les médias.
- Logiciel fourni « tel quel » (voir [LICENSE](LICENSE)). N’utilisez Forget que sur **vos propres comptes**.

## Fonctionnalités

| Plateforme | Connexion | Ce que Forget fait |
|---|---|---|
| Discord | Votre token (saisie ou fenêtre de connexion consentie) | Recherche, sélection souris (Maj+clic), suppression/édition en masse, « tous les résultats de la recherche », conversation entière, plages de dates, purges planifiées sans plafond, mode disparition, import d’export Discord |
| X (Twitter) | OAuth 2.0 PKCE avec **votre** application, ou jeton | Chargement paginé, filtres, sélection jusqu’à 500, suppression API |
| Reddit | OAuth (application « installed ») avec **votre** Client ID, ou jeton | Publications et commentaires, filtres, suppression API |
| TikTok | Votre session dans une fenêtre isolée | Inventaire des republications, filtres, retrait cadencé avec pauses automatiques |
| Facebook, Instagram | Fenêtre officielle isolée | Nettoyage assisté (vous cliquez dans l’interface officielle) |
| Data brokers | Local | Catalogue de 97 courtiers, scans, demandes de suppression (adaptateurs de démonstration) |

Garde-fous communs : aperçu avant suppression, confirmation saisie (`SUPPRIMER`), délai de grâce de 5 s, protections
(épinglés, mots à ne jamais toucher), archive locale avant action, pause/reprise/arrêt, respect des quotas (429).

## Installation

Windows 10/11 x64. Téléchargez `Forget-<version>.exe` dans les [Releases](../../releases), vérifiez au besoin son
empreinte SHA-256 avec `SHA256SUMS.txt`, puis lancez-le depuis le dossier de votre choix.
Forget tient dans un seul fichier exécutable portable. Au démarrage, il s'extrait dans un dossier temporaire,
supprimé à la fermeture. Le premier lancement peut être un peu plus lent.
Aucune installation, aucun désinstalleur et aucun raccourci créé. L'exécutable n'est pas signé :
Windows SmartScreen peut afficher un avertissement.

Pour désinstaller Forget, fermez-le puis supprimez le fichier `.exe`. Les données restent dans
`%APPDATA%\forget-desktop\data\forget.sqlite` et le profil Electron dans `%APPDATA%\Forget`.
Pour tout effacer, supprimez aussi manuellement les dossiers `%APPDATA%\forget-desktop` et `%APPDATA%\Forget`.

## Mises à jour

Cliquez sur **Mettre à jour** (barre latérale) ou ouvrez **Réglages → Mises à jour**. Forget ne contacte GitHub que
lorsque vous cliquez. Il télécharge `Forget-<version>.exe` depuis la dernière release GitHub et vérifie son SHA-256
avec `SHA256SUMS.txt`. À la fermeture de Forget, il remplace le fichier `.exe` en cours d'utilisation par la nouvelle
version, puis relance Forget. Dans une version construite localement, indiquez d'abord le dépôt
`propriétaire/dépôt` dans ce même écran.

## Connecter X ou Reddit (OAuth)

Forget ne fournit aucun identifiant d’API : vous créez votre propre application.

1. **X** : sur developer.x.com, créez une application de type *Native App* (client public), activez OAuth 2.0 et déclarez
   l’URL de redirection `http://127.0.0.1:53682/forget/callback` (ou la vôtre). L’accès aux endpoints dépend de votre offre API X.
   **Reddit** : sur reddit.com/prefs/apps, créez une application de type *installed app* avec la même URL de redirection.
2. **Réglages → Confidentialité** : désactivez le mode hors-ligne.
3. Ouvrez la plateforme dans Forget, collez le **Client ID**, vérifiez l’URL de redirection, cliquez sur
   **Se connecter avec…** et autorisez l’accès dans la page officielle. Forget intercepte la redirection : rien n’écoute sur ce port.

Autorisations demandées : X `tweet.read tweet.write users.read offline.access` ; Reddit `identity history read edit`
(durée permanente pour le renouvellement automatique).

## TikTok : retirer ses republications

TikTok ne propose pas d’API officielle pour les reposts. Forget ouvre `tiktok.com` dans une fenêtre isolée : vous vous
connectez vous-même (Forget ne lit ni mot de passe ni cookie). Ensuite : **Vérifier la session** → **Lancer l’inventaire**
→ filtrer et sélectionner → **Retirer**. Une requête à la fois, intervalle fixe réglable (4 s par défaut). En cas de refus,
pause de 15 min puis nouvel essai ; arrêt après 3 refus consécutifs (réessayez une heure plus tard).

## Confidentialité

| Contrôle | État |
|---|---|
| Serveur | écoute uniquement sur `127.0.0.1` |
| Fenêtre principale | ne charge que l’URL locale ; navigation externe, `window.open` et permissions refusés |
| Réseau | **aucune sortie** tant que le mode hors-ligne est actif (défaut) |
| Hors-ligne désactivé | hôtes explicites : Discord, `api.x.com`, `oauth.reddit.com`, `www.reddit.com` (OAuth), GitHub (mises à jour, au clic uniquement) |
| Fenêtres TikTok / Meta / OAuth | sessions séparées, sans accès Node, navigation limitée au domaine du service, ouvertes à votre demande |
| Télémétrie, crash reporter | aucun |
| Jetons | chiffrés au repos par DPAPI Windows (Electron `safeStorage`) quand disponible, jamais renvoyés par l’API |
| Données | SQLite locale `%APPDATA%\forget-desktop\data\forget.sqlite` (archive des messages en clair) |

## Développement

Prérequis : Node.js 22.13 ou plus récent (module `node:sqlite`).

```bash
npm run install:all      # dépendances serveur + web + desktop
npm run build            # interface web (Vite)
npm start                # build puis serveur local http://127.0.0.1:4173
npm run dev:web          # interface avec rechargement à chaud
npm run desktop:build    # dist-desktop/Forget-<version>.exe
npm run test:all         # toutes les suites de tests
```

Architecture : `server/` (API locale Hono, SQLite, moteurs Discord / X / Reddit / TikTok, verrou réseau, mises à jour),
`web/` (React + Vite), `desktop/` (Electron : fenêtres isolées, durcissement, build electron-builder).

## Publier une version

1. Mettre le même numéro dans `package.json`, `server/package.json`, `web/package.json`, `desktop/package.json`,
   `server/src/version.mjs` et `web/src/lib.js`, puis ajouter la section correspondante dans [CHANGELOG.md](CHANGELOG.md).
2. `git tag vX.Y.Z && git push origin vX.Y.Z` : le workflow **Release** teste, construit, calcule `SHA256SUMS.txt` et
   publie la release avec exactement `Forget-<version>.exe` et `SHA256SUMS.txt`. Le nom du dépôt est intégré à l’application pour le bouton de mise à jour.

## Sécurité et contributions

[SECURITY.md](SECURITY.md) (signalement privé), [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE), copyright Forget contributors.

---

## English

**Forget** is a 100 % local Windows desktop app to clean up **your own** history: Discord messages, X and Reddit posts
(official OAuth with your own app's client ID), TikTok reposts (through your own logged-in web session), plus data-broker
scans. Download one portable exe, `Forget-<version>.exe`, optionally verify it with `SHA256SUMS.txt`, and run it from
any folder. It extracts to a temporary folder at startup and removes that folder on exit. The first launch may be slower.
There is no installation, uninstaller, or shortcut creation. SmartScreen may warn because the executable is unsigned.
To uninstall, delete the exe. To remove all data too, manually delete `%APPDATA%\forget-desktop` (database:
`data\forget.sqlite`) and `%APPDATA%\Forget` (Electron profile).
Offline by default, no telemetry; updates are checked only when you click **Update**. Forget downloads the latest
release's portable exe, verifies its SHA-256 with `SHA256SUMS.txt`, then replaces the current exe on exit and restarts Forget.
Automating a Discord user account, or TikTok's undocumented web requests, may violate those
services' terms and get your account suspended. Deletions are irreversible. MIT licensed, provided "as is".
