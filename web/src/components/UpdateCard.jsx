import React, { useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, Field, Notice } from './Card.jsx';
import Progress from './Progress.jsx';
import { fmtDate } from '../lib.js';

const mb = (n) => `${(Number(n || 0) / 1048576).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;

// Update: check the latest GitHub release on demand, then replace and relaunch Forget.exe after SHA-256 verification.
export default function UpdateCard() {
  const u = useLoad(() => api.get('/update'), { poll: (d) => ['downloading', 'verifying', 'installing', 'checking'].includes(d?.state?.phase) });
  const [repo, setRepo] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const d = u.data || {};
  const r = d.release;
  const phase = d.state?.phase;
  const working = ['downloading', 'verifying', 'installing'].includes(phase);

  async function act(fn) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); await u.reload(true); } }

  return (
    <Card id="mise-a-jour" title="Updates" subtitle="No automatic checks: GitHub is contacted only when you click.">
      <div className="update-box">
        <p className="muted small">Installed version: <strong>{d.current || '…'}</strong>{d.repo ? <> · repository <code>{d.repo}</code></> : ''}</p>
        {(error || u.error) && <Notice tone="error">{error || u.error}</Notice>}
        {phase === 'error' && d.state.error && !error && <Notice tone="error">{d.state.error}</Notice>}
        {!d.repo || repo !== null ? (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.put('/update/repo', { repo: repo ?? '' }); setRepo(null); }); }}>
            <Field label="GitHub release repository" hint="Format: owner/repository, for example myaccount/forget.">
              <input value={repo ?? d.repo ?? ''} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repository" spellCheck={false} />
            </Field>
            <button className="btn" disabled={busy}>Save</button>
          </form>
        ) : (
          <div className="row wrap">
            <button className="btn primary" disabled={busy || working} onClick={() => act(() => api.post('/update/check'))}>{phase === 'checking' ? "Checking…" : "Check for updates"}</button>
            <button className="btn link" onClick={() => setRepo(d.repo)}>Change repository</button>
          </div>
        )}
        {r && !r.available && <Notice tone="info">Forget is up to date (latest release: {r.latest}).</Notice>}
        {r?.available && (
          <div className="stack">
            <Notice tone="info">New version available: <strong>{r.latest}</strong>{r.publishedAt ? ` (released on ${fmtDate(r.publishedAt)})` : ''}.</Notice>
            {r.notes && <div className="update-notes small">{r.notes}</div>}
            {!r.installable && <Notice tone="warn">This release has no verifiable executable (Forget-&lt;version&gt;.exe and SHA256SUMS.txt). Download it from GitHub.</Notice>}
            {r.installable && !d.installer && <Notice>Automatic updates are available only in Forget.exe (portable version).</Notice>}
            {r.installable && d.installer && (
              <div className="row wrap">
                <button className="btn primary" disabled={busy || working} onClick={() => act(() => api.post('/update/install'))}>Update to {r.latest}</button>
                <span className="muted small">{r.asset?.name} · {mb(r.asset?.size)} · Forget will close, replace its .exe file, and restart.</span>
              </div>
            )}
          </div>
        )}
        {phase === 'downloading' && <Progress value={d.state.received} max={d.state.total || d.state.received || 1} label="Downloading update" />}
        {phase === 'downloading' && <p className="muted small">{mb(d.state.received)} / {mb(d.state.total)}</p>}
        {phase === 'verifying' && <p className="muted small">Verifying SHA-256 checksum…</p>}
        {phase === 'installing' && <Notice tone="info">New version verified. Forget will restart.</Notice>}
      </div>
    </Card>
  );
}
