import React from 'react';
import EmptyState from './EmptyState.jsx';
import { Spinner } from './Card.jsx';
import { useApp } from '../hooks.js';

/**
 * Shows content only when Discord is connected; otherwise shows the appropriate state
 * (loading, API offline, module missing, disconnected).
 */
export default function DiscordGate({ children }) {
  const { discord, navigate, reloadDiscord } = useApp();
  switch (discord.state) {
    case 'connected':
      return children;
    case 'loading':
      return <Spinner label="Checking Discord account..." />;
    case 'unavailable':
      return (
        <EmptyState
          icon="warn"
          title="Discord module unavailable"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Retry</button>}
        >
          The server does not support /api/discord routes yet. Update the server and try again.
        </EmptyState>
      );
    case 'apidown':
      return (
        <EmptyState
          icon="warn"
          title="API unavailable"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Retry</button>}
        >
          Cannot reach the local server (127.0.0.1:4173).
        </EmptyState>
      );
    case 'error':
      return (
        <EmptyState
          icon="warn"
          title="Discord module error"
          action={<button type="button" className="btn" onClick={() => reloadDiscord()}>Retry</button>}
        >
          {discord.error || "Unexpected server response."}
        </EmptyState>
      );
    default:
      return (
        <EmptyState
          icon="lock"
          title="Discord not connected"
          action={<button type="button" className="btn primary" onClick={() => navigate('overview')}>Connect my account</button>}
        >
          Enter your token in Overview to use this page.
        </EmptyState>
      );
  }
}
