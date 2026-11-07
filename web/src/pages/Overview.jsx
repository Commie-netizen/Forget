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
      setError("Enter your Discord token.");
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.discordSetToken(t);
      setToken('');
      await reloadDiscord();
    } catch (err) {
      setError(err.status === 401 ? "Invalid token: Discord rejected it." : err.message);
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
        setInfo("Built-in login is available only in the desktop app. Use the advanced option below with your token.");
        setAdvanced(true);
      } else if (err.status === 400) {
        setInfo("Login cancelled.");
      } else {
        setError(err.status === 401 ? "Discord rejected the login." : err.message);
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
      <PageHeader title="Overview" subtitle="Your connected accounts and protection status." />

      {offlineMode && !connected && (
        <Notice tone="info" title="Offline mode active">
          All outgoing connections are blocked (maximum protection). To connect Discord,
          disable offline mode in <strong>Settings → Privacy</strong>.
        </Notice>
      )}

      <div className="cols">
        <Card
          title="Discord account"
          actions={
            <Badge tone={connected ? 'green' : unavailable ? 'orange' : 'neutral'}>
              {connected ? "Connected" : unavailable ? "Module unavailable" : "Not connected"}
            </Badge>
          }
        >
          {unavailable && (
            <Notice tone="warn" title="Discord module unavailable">
              The server is not responding at /api/discord. You can connect once the module is active.
            </Notice>
          )}
          {discord.state === 'apidown' && <Notice tone="error">API unavailable: local server unreachable.</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {info && <Notice tone="info">{info}</Notice>}

          {connected ? (
            <div className="stack">
              <div className="identity">
                <span className="avatar big tone-red" aria-hidden="true">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{user?.username || "Connected account"}</strong>
                  <div className="muted small mono">ID {user?.id || '-'}</div>
                </div>
              </div>
              <dl className="kv">
                <dt>Token</dt>
                <dd className="mono">{discord.tokenMasked || '••••••••'}</dd>
                <dt>Disappearing Mode</dt>
                <dd>{discord.disappearing?.enabled ? "Active" : "Disabled"}</dd>
              </dl>
              <div className="actions">
                <button type="button" className="btn primary" onClick={() => navigate('discord')}>Manage my messages</button>
                <button type="button" className="btn danger" onClick={() => setConfirmOut(true)}>Log out</button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <div className="actions">
                <button type="button" className="btn primary" disabled={busy || unavailable} onClick={loginWindow}>
                  {busy ? "Connecting..." : "Log in with Discord"}
                </button>
              </div>
              <p className="muted small">A Discord window opens. The app never reads or stores your password.</p>
              <details className="advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                <summary>Advanced option: enter a token manually</summary>
                <form className="stack" onSubmit={connect} autoComplete="off">
                  <Field
                    label="Discord token"
                    hint="Entered once, stored in the local SQLite database, never returned by the API or sent anywhere except discord.com."
                  >
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Paste your token"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy || unavailable}
                    />
                  </Field>
                  <div className="actions">
                    <button type="submit" className="btn" disabled={busy || unavailable || !token.trim()}>
                      {busy ? "Verifying..." : "Connect with this token"}
                    </button>
                  </div>
                </form>
              </details>
              <Notice tone="warn" title="Use only your own account">
                Automating a user account may violate Discord’s terms of service. You are responsible for your actions.
              </Notice>
            </div>
          )}
        </Card>

        <div className="stack">
          <div className="grid stats two">
            <Stat label="Servers" value={connected ? nf(counts.guildsCount) : '-'} />
            <Stat label="Direct messages" value={connected ? nf(counts.dmCount) : '-'} />
          </div>
          <Card title="Shortcuts">
            <div className="stack">
              <button type="button" className="btn" onClick={() => navigate('disappearing')}>
                Disappearing Mode: {discord.disappearing?.enabled ? "active" : "disabled"}
              </button>
              <button type="button" className="btn" onClick={() => navigate('archive')}>
                Local Archive: {localArchive ? 'ON' : 'OFF'}
              </button>
              <button type="button" className="btn" onClick={() => navigate('schedule')}>Schedule a task</button>
            </div>
          </Card>
        </div>
      </div>

      <Confirm
        open={confirmOut}
        title="Log out of Discord?"
        confirmLabel="Log out"
        danger
        busy={busy}
        onCancel={() => setConfirmOut(false)}
        onConfirm={disconnect}
      >
        <p>The token will be deleted from the local database and Disappearing Mode will stop. Local archives will be kept.</p>
      </Confirm>
    </>
  );
}
