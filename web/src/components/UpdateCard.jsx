import React, { useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, Field, Notice } from './Card.jsx';
import Progress from './Progress.jsx';
import { fmtDate } from '../lib.js';

const mb = (n) => `${(Number(n || 0) / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;

// « Mettre à jour » : vérification à la demande de la dernière release GitHub, puis Forget.exe vérifié (SHA-256) remplacé et relancé.
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
    <Card id="mise-a-jour" title="Mises à jour" subtitle="Aucune vérification automatique : GitHub n’est contacté que lorsque vous cliquez.">
      <div className="update-box">
        <p className="muted small">Version installée : <strong>{d.current || '…'}</strong>{d.repo ? <> · dépôt <code>{d.repo}</code></> : ''}</p>
        {(error || u.error) && <Notice tone="error">{error || u.error}</Notice>}
        {phase === 'error' && d.state.error && !error && <Notice tone="error">{d.state.error}</Notice>}
        {!d.repo || repo !== null ? (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.put('/update/repo', { repo: repo ?? '' }); setRepo(null); }); }}>
            <Field label="Dépôt GitHub des releases" hint="Format propriétaire/dépôt, par exemple moncompte/forget.">
              <input value={repo ?? d.repo ?? ''} onChange={(e) => setRepo(e.target.value)} placeholder="propriétaire/dépôt" spellCheck={false} />
            </Field>
            <button className="btn" disabled={busy}>Enregistrer</button>
          </form>
        ) : (
          <div className="row wrap">
            <button className="btn primary" disabled={busy || working} onClick={() => act(() => api.post('/update/check'))}>{phase === 'checking' ? 'Vérification…' : 'Rechercher une mise à jour'}</button>
            <button className="btn link" onClick={() => setRepo(d.repo)}>Changer de dépôt</button>
          </div>
        )}
        {r && !r.available && <Notice tone="info">Forget est à jour (dernière release : {r.latest}).</Notice>}
        {r?.available && (
          <div className="stack">
            <Notice tone="info">Nouvelle version disponible : <strong>{r.latest}</strong>{r.publishedAt ? ` (publiée le ${fmtDate(r.publishedAt)})` : ''}.</Notice>
            {r.notes && <div className="update-notes small">{r.notes}</div>}
            {!r.installable && <Notice tone="warn">Cette release ne contient pas d’exécutable vérifiable (Forget-&lt;version&gt;.exe et SHA256SUMS.txt). Téléchargez-la depuis GitHub.</Notice>}
            {r.installable && !d.installer && <Notice>La mise à jour automatique n’est disponible que dans Forget.exe (version portable).</Notice>}
            {r.installable && d.installer && (
              <div className="row wrap">
                <button className="btn primary" disabled={busy || working} onClick={() => act(() => api.post('/update/install'))}>Mettre à jour vers {r.latest}</button>
                <span className="muted small">{r.asset?.name} · {mb(r.asset?.size)} · Forget se fermera, remplacera son fichier .exe puis redémarrera.</span>
              </div>
            )}
          </div>
        )}
        {phase === 'downloading' && <Progress value={d.state.received} max={d.state.total || d.state.received || 1} label="Téléchargement de la mise à jour" />}
        {phase === 'downloading' && <p className="muted small">{mb(d.state.received)} / {mb(d.state.total)}</p>}
        {phase === 'verifying' && <p className="muted small">Vérification de la somme SHA-256…</p>}
        {phase === 'installing' && <Notice tone="info">Nouvelle version vérifiée. Forget va redémarrer.</Notice>}
      </div>
    </Card>
  );
}
