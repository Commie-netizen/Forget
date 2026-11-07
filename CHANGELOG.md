# Notes de version

Format : une section par version, la plus récente en premier. Le workflow de release publie le texte de la section
correspondant au tag (`v4.3.0` → `## 4.3.0`).

## 4.3.0

### Nouveautés
- Un seul fichier : `Forget-<version>.exe` portable remplace l'installeur ; la mise à jour remplace ce fichier et relance Forget.
- **Bouton « Mettre à jour »** (barre latérale et Réglages → Mises à jour) : vérifie la dernière release GitHub à la demande,
  télécharge l'exécutable portable, contrôle son SHA-256 avec le fichier `SHA256SUMS.txt` de la release,
  puis remplace le fichier à la fermeture et relance Forget.
  Aucune vérification automatique en arrière-plan.
- **TikTok : retrait des republications (reposts)**. Inventaire complet de vos reposts depuis votre propre session web,
  filtres (description, auteur), sélection (Maj+clic pour une plage), archive locale avant chaque retrait,
  cadence fixe réglable (2 à 60 s), pause/reprise/arrêt, refroidissement de 15 min sur refus, arrêt après 3 refus.
- **Connexion OAuth X et Reddit** : bouton « Se connecter avec… » utilisant le Client ID de *votre* application
  (PKCE S256 pour X, application « installed » pour Reddit). Renouvellement automatique des jetons (refresh token).
  La saisie manuelle d’un jeton reste disponible.
- **Discord, nouvelles façons de supprimer** :
  - portée « Tous les résultats de la recherche » (contenu + dates, sur un salon ou tout un serveur) ;
  - protections : conserver les messages épinglés, seulement les messages avec pièce jointe, mots à ne jamais toucher ;
  - aperçu avant suppression (estimation et exemples, une seule recherche, aucune action) ;
  - délai de grâce de 5 s après confirmation, avec « Annuler » et « Lancer maintenant » ;
  - Maj+clic pour sélectionner une plage, « Inverser la page ».
- X/Reddit : filtre d’exclusion, inversion de sélection, Maj+clic.

### Sécurité
- Serveur local protégé contre les sites web malveillants : suppression du CORS permissif (un site pouvait lire
  l'archive), refus du DNS rebinding (`Host`), du CSRF (`Origin`, `Sec-Fetch-Site`, en-tête `X-Forget-Request`).
- En-têtes de sécurité et CSP stricte ; liens externes limités à `http(s)`.
- Import ZIP à mémoire bornée (les entrées ignorées ne sont plus gardées en mémoire), bombes ZIP stoppées.
- Exports CSV protégés contre l'injection de formules ; expression régulière d'édition limitée à 500 caractères.
- Fuses Electron (pas de RunAsNode, NODE_OPTIONS ni --inspect ; intégrité d'app.asar ; cookies chiffrés).
- Session web Discord effacée après récupération du token.
- `@hono/node-server` 2.1.6 (avis de sécurité corrigés) ; actions GitHub épinglées par SHA, `persist-credentials: false`.
- Nouveau test `npm run test:security`.

### Corrections
- Purges planifiées : le choix de vitesse « Fast » était ignoré (toujours « Safe »).
- `PATCH /api/settings` ne peut plus écrire les clés réservées (`privacy.*`, `discord.*`, `update.*`…).
- Version serveur affichée à 4.0.0 au lieu de la version réelle.

### Performances
- Requêtes SQLite préparées une seule fois (cache) dans le module Discord et le verrou réseau.
- Fenêtres Facebook/Instagram : l’état hors-ligne n’est plus relu en base à chaque ressource chargée.
- Chargement des salons de tous les serveurs Discord en parallèle (régulé par le limiteur de débit).
- Interface : aucun rafraîchissement quand la fenêtre est masquée ; pas de re-rendu si les données n’ont pas changé.

### Technique
- Version unique dans `server/src/version.mjs`.
- Exécutable portable nommé `Forget-<version>.exe`.
- Nouveau test `npm run test:v43` ; `npm run test:all` lance toutes les suites.

## 4.2.0
- Pages Twitter/X et Reddit (jeton OAuth utilisateur, chargement paginé, sélection, archive, suppression API).
- Facebook et Instagram en nettoyage assisté (fenêtre officielle isolée).
- Import d’un export Discord (ZIP, dossier) ou d’une base Forget Engine, purge par plan.

## 4.1.0
- Limiteur de débit Discord partagé par jeton, bannière globale des opérations.

## 4.0.0
- Première version publique de Forget.
