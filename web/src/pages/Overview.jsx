import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Stat, Field } from '../components/Card.jsx';
import Badge from '../components/Badge.jsx';
import { Confirm } from '../components/Modal.jsx';
import { nf } from '../lib.js';

export default function Overview() {
  const { discord, reloadDiscord, navigate, localArchive } = useApp();
  const connected = discord.state === 'connected';
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  const me = useLoad(() => api.discordMe(), { enabled: connected, deps: [connected] });
  const privacy = useLoad(() => api.get('/privacy'), { deps: [] });
  const offlineMode = privacy.data?.offline === true;

  async function connect(e) {
    e.preventDefault();
    const t = token.trim();
    if (!t) {
      setError('Saisissez votre token Discord.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.discordSetToken(t);
      setToken('');
      await reloadDiscord();
    } catch (err) {
      setError(err.status === 401 ? 'Token invalide : Discord l’a refusé.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loginWindow() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api.discordLoginWindow();
      await reloadDiscord();
    } catch (err) {
      if (err.status === 501 || err.status === 404) {
        setInfo('Connexion intégrée réservée à l’application de bureau. Utilisez l’option avancée ci-dessous avec votre token.');
        setAdvanced(true);
      } else if (err.status === 400) {
        setInfo('Connexion annulée.');
      } else {
        setError(err.status === 401 ? 'Discord a refusé la connexion.' : err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api.discordClearToken();
      setConfirmOut(false);
      await reloadDiscord();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const user = discord.user;
  const unavailable = discord.state === 'unavailable';
  const counts = me.data || {};

  return (
    <>
      <PageHeader title="Overview" subtitle="Vos comptes reliés et l’état de la protection." />

      {offlineMode && !connected && (
        <Notice tone="info" title="Mode hors-ligne actif">
          Aucune connexion sortante n’est autorisée (protection maximale). Pour connecter Discord,
          désactivez le mode hors-ligne dans <strong>Réglages → Confidentialité</strong>.
        </Notice>
      )}

      <div className="cols">
        <Card
          title="Compte Discord"
          actions={
            <Badge tone={connected ? 'green' : unavailable ? 'orange' : 'neutral'}>
              {connected ? 'Connecté' : unavailable ? 'Module indisponible' : 'Non connecté'}
            </Badge>
          }
        >
          {unavailable && (
            <Notice tone="warn" title="Module Discord indisponible">
              Le serveur ne répond pas sur /api/discord. La connexion sera possible dès que le module sera actif.
            </Notice>
          )}
          {discord.state === 'apidown' && <Notice tone="error">API indisponible : serveur local injoignable.</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {info && <Notice tone="info">{info}</Notice>}

          {connected ? (
            <div className="stack">
              <div className="identity">
                <span className="avatar big tone-red" aria-hidden="true">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{user?.username || 'Compte connecté'}</strong>
                  <div className="muted small mono">ID {user?.id || '-'}</div>
                </div>
              </div>
              <dl className="kv">
                <dt>Token</dt>
                <dd className="mono">{discord.tokenMasked || '••••••••'}</dd>
                <dt>Mode disparition</dt>
                <dd>{discord.disappearing?.enabled ? 'Actif' : 'Désactivé'}</dd>
              </dl>
              <div className="actions">
                <button type="button" className="btn primary" onClick={() => navigate('discord')}>Gérer mes messages</button>
                <button type="button" className="btn danger" onClick={() => setConfirmOut(true)}>Se déconnecter</button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <div className="actions">
                <button type="button" className="btn primary" disabled={busy || unavailable} onClick={loginWindow}>
                  {busy ? 'Connexion...' : 'Se connecter avec Discord'}
                </button>
              </div>
              <p className="muted small">Une fenêtre Discord s’ouvre ; votre mot de passe n’est jamais lu ni stocké par l’application.</p>
              <details className="advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                <summary>Option avancée : saisir un token manuellement</summary>
                <form className="stack" onSubmit={connect} autoComplete="off">
                  <Field
                    label="Token Discord"
                    hint="Saisi une seule fois, stocké localement dans la base SQLite, jamais renvoyé par l’API ni transmis ailleurs qu’à discord.com."
                  >
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Collez votre token"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy || unavailable}
                    />
                  </Field>
                  <div className="actions">
                    <button type="submit" className="btn" disabled={busy || unavailable || !token.trim()}>
                      {busy ? 'Vérification...' : 'Se connecter avec ce token'}
                    </button>
                  </div>
                </form>
              </details>
              <Notice tone="warn" title="Utilisez uniquement votre propre compte">
                Automatiser un compte utilisateur peut enfreindre les conditions d’utilisation de Discord. Vous agissez sous votre responsabilité.
              </Notice>
            </div>
          )}
        </Card>

        <div className="stack">
          <div className="grid stats two">
            <Stat label="Serveurs" value={connected ? nf(counts.guildsCount) : '-'} />
            <Stat label="Messages privés" value={connected ? nf(counts.dmCount) : '-'} />
          </div>
          <Card title="Raccourcis">
            <div className="stack">
              <button type="button" className="btn" onClick={() => navigate('disappearing')}>
                Mode disparition : {discord.disappearing?.enabled ? 'actif' : 'désactivé'}
              </button>
              <button type="button" className="btn" onClick={() => navigate('archive')}>
                Local Archive : {localArchive ? 'ON' : 'OFF'}
              </button>
              <button type="button" className="btn" onClick={() => navigate('schedule')}>Planifier une tâche</button>
            </div>
          </Card>
        </div>
      </div>

      <Confirm
        open={confirmOut}
        title="Se déconnecter de Discord ?"
        confirmLabel="Se déconnecter"
        danger
        busy={busy}
        onCancel={() => setConfirmOut(false)}
        onConfirm={disconnect}
      >
        <p>Le token sera supprimé de la base locale et le mode disparition sera arrêté. Les archives locales restent conservées.</p>
      </Confirm>
    </>
  );
}
