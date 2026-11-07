# Politique de sécurité

## Signaler une vulnérabilité

Ne publiez **pas** de faille dans une issue publique. Utilisez les avis de sécurité privés du dépôt (onglet Security, « Report a vulnerability »). Indiquez : version, étapes de reproduction, impact. Réponse visée sous 7 jours.

Versions supportées : la dernière version publiée.

## Modèle de menace

Forget est une application Windows locale (Electron + serveur Node lié à `127.0.0.1` + SQLite).

Protégé :

- Aucune sortie réseau en mode hors-ligne (défaut). Hors-ligne désactivé : uniquement `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com`, `media.discordapp.net`.
- Le serveur n'écoute que sur la boucle locale ; la fenêtre ne charge que l'URL locale ; navigation externe, `window.open` et permissions sont refusés.
- Le token n'est jamais renvoyé en clair par l'API (masqué) et n'est envoyé qu'à Discord. Il est chiffré au repos via DPAPI Windows (Electron `safeStorage`) lorsque disponible.

Limites connues :

- Un attaquant ayant déjà accès à votre session Windows peut déchiffrer le token DPAPI.
- L'archive locale des messages est stockée **en clair** dans la base SQLite.
- Un malware local s'exécutant avec les droits de l'utilisateur n'est pas couvert.
- L'usage d'un token utilisateur (self-bot) enfreint les CGU de Discord ; ce risque est assumé par l'utilisateur.

## Protections du serveur local

L'interface parle à un serveur qui écoute uniquement sur `127.0.0.1`. Une page web ouverte dans un navigateur peut
envoyer des requêtes vers cette adresse ; Forget les refuse :

- **DNS rebinding** : l'en-tête `Host` doit désigner une adresse de bouclage (`127.0.0.1`, `localhost`, `[::1]`).
- **CSRF** : une requête portant un `Origin` doit venir de la même origine ; `Sec-Fetch-Site` doit valoir
  `same-origin` ou `none` ; toute écriture exige l'en-tête `X-Forget-Request`. Aucun en-tête CORS n'est émis.
- **En-têtes** : CSP stricte (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, `DENY`.
- **Fichiers importés** : archives ZIP lues par le répertoire central, entrées décompressées une à une avec plafonds
  (64 Mo par fichier, 2 Go au total) ; aucun chemin de l'archive n'est écrit sur disque.
- **Exports CSV** : les cellules commençant par `= + - @` sont neutralisées (injection de formules).

Un programme malveillant déjà exécuté sous votre compte Windows reste hors de ce modèle : il peut lire la base locale.

## Durcissement de l'exécutable

Fuses Electron : pas de mode `RunAsNode`, `NODE_OPTIONS` et `--inspect` ignorés, application chargée uniquement depuis
`app.asar` avec contrôle d'intégrité, cookies chiffrés. Fenêtres : `contextIsolation`, `sandbox`, pas de `nodeIntegration`,
navigation et `window.open` bloqués hors du domaine prévu, permissions refusées. La session web Discord de la fenêtre de
connexion est effacée dès que le token a été récupéré.

## Ce qui n'est jamais collecté

Aucune télémétrie, aucun rapport de crash, aucune vérification de mise à jour en arrière-plan (GitHub n'est contacté que sur clic du bouton « Mettre à jour », et le SHA-256 de l'exécutable portable téléchargé est vérifié avec `SHA256SUMS.txt` avant de remplacer le fichier courant à la fermeture et de relancer Forget), aucun compte, aucun service tiers. Le token n'est jamais extrait automatiquement d'une autre application : il est saisi par l'utilisateur ou obtenu via une fenêtre de connexion intégrée explicitement consentie.

## Security policy (English)

Report vulnerabilities privately through GitHub security advisories, not public issues. Forget is fully local, offline by default, collects no telemetry, and never extracts tokens from other applications. The local message archive is stored unencrypted in SQLite.
