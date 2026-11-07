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
  let label = "Verifying...";
  let tone = 'muted';
  if (d) {
    const on = d.tokenEncrypted === true || d.cipher === 'dpapi';
    label = on ? "Windows DPAPI (active)" : "missing";
    tone = on ? 'c-green' : 'c-orange';
  } else if (sec.error || !sec.loading) {
    label = "missing";
    tone = 'c-orange';
  }
  return (
    <div className="row">
      <span className="grow">Token encryption</span>
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
    <Card title="Privacy" subtitle="Network lock and offline mode.">
      <div className="stack">
        <Notice tone="ok">100% local app. Forget does not contact third-party servers or collect telemetry</Notice>
        {unavailable && <Notice tone="warn">Privacy settings unavailable (API unreachable). Offline mode remains active on the server by default.</Notice>}
        <Notice tone="error">{err}</Notice>
        <TokenSecurityRow />
        <div className="row">
          <span className="grow">Offline mode</span>
          <Toggle
            checked={p ? p.offline !== false : true}
            onChange={() => p && !busy && setOffline(p.offline === false)}
            label="Offline mode"
          />
        </div>
        <p className="muted small">
          ON: no outgoing connections. OFF: Discord, X, and Reddit APIs are allowed, and GitHub only when you click "Check for updates". Facebook, Instagram, TikTok, and OAuth login windows open on request and stay restricted to the service’s domain.
        </p>
        {p && p.offline === false && (
          <div>
            <p className="small">Allowed domains:</p>
            <ul className="small">
              {(p.allowed || []).map((h) => <li key={h}><code>{h}</code></li>)}
            </ul>
          </div>
        )}
        {p && (
          <div className="row">
            <span className="grow">
              Blocked requests: <strong>{p.stats?.blocked ?? 0}</strong>
              {p.stats?.lastBlockedHost ? <span className="muted small"> (last: {p.stats.lastBlockedHost})</span> : null}
            </span>
            <button type="button" className="btn" onClick={resetStats}>Reset</button>
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
      <PageHeader title="Settings" subtitle="Appearance, data, and information." />
      <PrivacySection />
      <Notice tone="error">{error || settings.error}</Notice>
      <Notice tone="warn" title="Warning: Discord terms of service">
        Automating a user account (self-bot) violates Discord’s terms of service and may result in account suspension. Use this app only on your own account, at your own risk.
      </Notice>

      <div className="cols">
        <Card title="Appearance and app">
          <div className="stack">
            <Select
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[{ value: 'dark', label: "Dark" }, { value: 'light', label: "Light" }]}
            />
            <div className="row">
              <span className="grow">Start minimized</span>
              <Toggle checked={truthy(s.startMinimized)} onChange={() => toggle('startMinimized')} label="Start minimized" />
            </div>
            <div className="row">
              <span className="grow">Enable notifications</span>
              <Toggle checked={truthy(s.notifications)} onChange={() => toggle('notifications')} label="Enable notifications" />
            </div>
            <div className="row">
              <span className="grow">Local Archive</span>
              <Toggle checked={localArchive} onChange={setLocalArchive} label="Enable Local Archive" />
            </div>
            <div>
              <button type="button" className="btn" onClick={() => navigate('profiles')}>Manage profiles</button>
            </div>
          </div>
        </Card>

        <div className="stack">
          <Card title="Data export">
            <div className="actions">
              {['csv', 'json', 'zip'].map((f) => (
                <a key={f} className="btn" href={api.exportUrl(f)} download>
                  <Icon name="download" size={16} /> {f.toUpperCase()}
                </a>
              ))}
            </div>
            <p className="muted small">Export profiles, scans, and archives from the main engine.</p>
          </Card>
          <UpdateCard />
          <Card title="About">
            <dl className="kv">
              <dt>Interface</dt>
              <dd>{APP_VERSION}</dd>
              <dt>Server</dt>
              <dd>{health?.version || "unknown"}</dd>
              <dt>Mode</dt>
              <dd>{health?.mode === 'demo' ? "Demo (simulated adapters)" : health?.mode || '-'}</dd>
              <dt>API</dt>
              <dd>{apiOk === false ? "Unavailable" : apiOk ? "Connected" : "Verifying..."}</dd>
              <dt>Discord</dt>
              <dd>
                {{ connected: "Connected", disconnected: "Not connected", unavailable: "Module unavailable", apidown: "API unavailable", loading: "Verifying..." }[discord.state] || "Error"}
              </dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
