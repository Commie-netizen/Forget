import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice } from '../components/Card.jsx';
import Toggle from '../components/Toggle.jsx';
import Select from '../components/Select.jsx';
import Icon from '../components/Icon.jsx';
import { APP_VERSION } from '../lib.js';
import UpdateCard from '../components/UpdateCard.jsx';

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

function TokenSecurityRow() {
  const sec = useLoad(() => api.security());
  const d = sec.data;
  let label = 'Vérification...';
  let tone = 'muted';
  if (d) {
    const on = d.tokenEncrypted === true || d.cipher === 'dpapi';
    label = on ? 'DPAPI Windows (actif)' : 'absent';
    tone = on ? 'c-green' : 'c-orange';
  } else if (sec.error || !sec.loading) {
    label = 'absent';
    tone = 'c-orange';
  }
  return (
    <div className="row">
      <span className="grow">Chiffrement du token</span>
      <strong className={tone}>{label}</strong>
    </div>
  );
}

function PrivacySection() {
  const priv = useLoad(() => api.get('/privacy'));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const p = priv.data;
  const unavailable = !p && !!priv.error;

  async function setOffline(offline) {
    setErr('');
    setBusy(true);
    try {
      await api.patch('/privacy', { offline });
      await priv.reload(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetStats() {
    setErr('');
    try {
      await api.post('/privacy/reset-stats');
      await priv.reload(true);
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <Card title="Confidentialité" subtitle="Verrou réseau et mode hors-ligne.">
      <div className="stack">
        <Notice tone="ok">Application 100 % locale — Forget ne communique avec aucun serveur tiers, aucune télémétrie</Notice>
        {unavailable && <Notice tone="warn">Réglages de confidentialité indisponibles (API injoignable). Le mode hors-ligne reste actif côté serveur par défaut.</Notice>}
        <Notice tone="error">{err}</Notice>
        <TokenSecurityRow />
        <div className="row">
          <span className="grow">Mode hors-ligne</span>
          <Toggle
            checked={p ? p.offline !== false : true}
            onChange={() => p && !busy && setOffline(p.offline === false)}
            label="Mode hors-ligne"
          />
        </div>
        <p className="muted small">
          ON : aucune connexion sortante. OFF : les API Discord, X et Reddit sont autorisées, et GitHub uniquement quand vous cliquez sur « Rechercher une mise à jour ». Les fenêtres Facebook, Instagram, TikTok et de connexion OAuth s’ouvrent sur votre demande et restent limitées au domaine du service.
        </p>
        {p && p.offline === false && (
          <div>
            <p className="small">Domaines autorisés :</p>
            <ul className="small">
              {(p.allowed || []).map((h) => <li key={h}><code>{h}</code></li>)}
            </ul>
          </div>
        )}
        {p && (
          <div className="row">
            <span className="grow">
              Requêtes bloquées : <strong>{p.stats?.blocked ?? 0}</strong>
              {p.stats?.lastBlockedHost ? <span className="muted small"> (dernière : {p.stats.lastBlockedHost})</span> : null}
            </span>
            <button type="button" className="btn" onClick={resetStats}>Réinitialiser</button>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function Settings() {
  const { theme, setTheme, health, apiOk, navigate, discord, localArchive, setLocalArchive } = useApp();
  const [error, setError] = useState('');
  const settings = useLoad(() => api.getSettings());
  const s = settings.data || {};

  async function toggle(key) {
    setError('');
    try {
      await api.patchSettings({ [key]: !truthy(s[key]) });
      await settings.reload(true);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Apparence, données et informations." />
      <PrivacySection />
      <Notice tone="error">{error || settings.error}</Notice>
      <Notice tone="warn" title="Avertissement : conditions d’utilisation de Discord">
        Automatiser un compte utilisateur (« self-bot ») est contraire aux conditions d’utilisation de Discord et peut entraîner la suspension du compte. Utilisez cette application uniquement sur votre propre compte, à vos risques.
      </Notice>

      <div className="cols">
        <Card title="Apparence et application">
          <div className="stack">
            <Select
              label="Thème"
              value={theme}
              onChange={setTheme}
              options={[{ value: 'dark', label: 'Sombre' }, { value: 'light', label: 'Clair' }]}
            />
            <div className="row">
              <span className="grow">Démarrer en mode minimisé</span>
              <Toggle checked={truthy(s.startMinimized)} onChange={() => toggle('startMinimized')} label="Démarrer en mode minimisé" />
            </div>
            <div className="row">
              <span className="grow">Activer les notifications</span>
              <Toggle checked={truthy(s.notifications)} onChange={() => toggle('notifications')} label="Activer les notifications" />
            </div>
            <div className="row">
              <span className="grow">Local Archive</span>
              <Toggle checked={localArchive} onChange={setLocalArchive} label="Activer Local Archive" />
            </div>
            <div>
              <button type="button" className="btn" onClick={() => navigate('profiles')}>Gérer les profils</button>
            </div>
          </div>
        </Card>

        <div className="stack">
          <Card title="Export des données">
            <div className="actions">
              {['csv', 'json', 'zip'].map((f) => (
                <a key={f} className="btn" href={api.exportUrl(f)} download>
                  <Icon name="download" size={16} /> {f.toUpperCase()}
                </a>
              ))}
            </div>
            <p className="muted small">Export des profils, scans et archives du moteur principal.</p>
          </Card>
          <UpdateCard />
          <Card title="À propos">
            <dl className="kv">
              <dt>Interface</dt>
              <dd>{APP_VERSION}</dd>
              <dt>Serveur</dt>
              <dd>{health?.version || 'inconnue'}</dd>
              <dt>Mode</dt>
              <dd>{health?.mode === 'demo' ? 'Démo (adaptateurs simulés)' : health?.mode || '-'}</dd>
              <dt>API</dt>
              <dd>{apiOk === false ? 'Indisponible' : apiOk ? 'Connectée' : 'Vérification...'}</dd>
              <dt>Discord</dt>
              <dd>
                {{ connected: 'Connecté', disconnected: 'Non connecté', unavailable: 'Module indisponible', apidown: 'API indisponible', loading: 'Vérification...' }[discord.state] || 'Erreur'}
              </dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
