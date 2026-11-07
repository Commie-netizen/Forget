import React from 'react';
import EmptyState from './EmptyState.jsx';
import { Spinner } from './Card.jsx';
import { useApp } from '../hooks.js';

/**
 * Affiche le contenu uniquement si Discord est connecté ; sinon l'état adapté
 * (chargement, API coupée, module absent, non connecté).
 */
export default function DiscordGate({ children }) {
  const { discord, navigate, reloadDiscord } = useApp();
  switch (discord.state) {
    case 'connected':
      return children;
    case 'loading':
      return <Spinner label="Vérification du compte Discord..." />;
    case 'unavailable':
      return (
        <EmptyState
          icon="warn"
          title="Module Discord indisponible"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Réessayer</button>}
        >
          Le serveur ne propose pas encore les routes /api/discord. Mettez le serveur à jour puis réessayez.
        </EmptyState>
      );
    case 'apidown':
      return (
        <EmptyState
          icon="warn"
          title="API indisponible"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Réessayer</button>}
        >
          Impossible de joindre le serveur local (127.0.0.1:4173).
        </EmptyState>
      );
    case 'error':
      return (
        <EmptyState
          icon="warn"
          title="Erreur du module Discord"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Réessayer</button>}
        >
          {discord.error || 'Réponse inattendue du serveur.'}
        </EmptyState>
      );
    default:
      return (
        <EmptyState
          icon="lock"
          title="Discord non connecté"
          action={<button type="button" className="btn primary" onClick={() => navigate('overview')}>Connecter mon compte</button>}
        >
          Renseignez votre token dans Overview pour utiliser cette page.
        </EmptyState>
      );
  }
}
