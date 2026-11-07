import React, { useEffect, useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, Field, Notice, PageHeader, Stat } from '../components/Card.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { RateStatus, JobPanel } from './Discord.jsx';
import { nf, fmtDate } from '../lib.js';

export default function ExportPurge() {
  const [path, setPath] = useState(''), [query, setQuery] = useState(''), [kind, setKind] = useState('all');
  const [selected, setSelected] = useState(new Set()), [since, setSince] = useState(''), [until, setUntil] = useState('');
  const [planId, setPlanId] = useState(''), [workers, setWorkers] = useState(4), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const latest = useLoad(() => api.get('/import/latest'));
  const source = useLoad(() => api.get('/import/status'), { poll: d => !d || d.status === 'importing' });
  const batch = source.data;
  const channels = useLoad(() => api.get('/import/channels' + api.qs({ importId: batch?.id })), { deps: [batch?.id, batch?.status], enabled: batch?.status === 'ready' });
  const plan = useLoad(() => api.get(`/import/plan/${planId}`), { deps: [planId], enabled: !!planId, poll: d => !d || d.plan.status === 'running' });
  useEffect(() => { if (latest.data?.plan?.id) setPlanId(latest.data.plan.id); }, [latest.data]);
  const p = plan.data?.plan;
  const running = p?.status === 'running';
  const list = (channels.data || []).filter(c => (kind === 'all' || c.kind === kind) && `${c.name} ${c.cid}`.toLowerCase().includes(query.toLowerCase()));
  async function act(fn) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const invalidate = () => { if (!running) { setPlanId(''); plan.setData(null); } };
  async function choose(kind) {
    await act(async () => { const p = await window.forget.pickFile({ kind }); if (p) setPath(p); });
  }
  async function build() {
    await act(async () => {
      const r = await api.post('/import/plan', { importId: batch.id, channelIds: [...selected], since: since ? `${since}T00:00:00Z` : undefined, until: until ? `${until}T23:59:59.999Z` : undefined });
      plan.setData(null); setPlanId(r.planId);
    });
  }
  async function execute() {
    await act(async () => { await api.post(`/import/plan/${planId}/execute`, { confirm: true, concurrency: workers }); setConfirm(false); await plan.reload(true); });
  }
  return <>
    <PageHeader title="Nettoyer plusieurs conversations" subtitle="Importez votre historique. Choisissez précisément ce que vous souhaitez effacer." />
    <RateStatus />
    {error && <Notice tone="error">{error}</Notice>}
    <Card>
      <div className="export-hero"><div><h2>Un seul plan. Plusieurs conversations.</h2><p className="muted">Analyse locale, aperçu des messages et débit ajusté aux quotas Discord.</p></div><span className="badge">LOCAL</span></div>
      <div className="export-steps"><span>01 · Importer</span><span>02 · Sélectionner</span><span>03 · Vérifier et supprimer</span></div>
    </Card>
    <Card title="1. Votre source" subtitle="Export Discord ZIP, dossier extrait ou base Forget Engine. Aucun Python à lancer.">
      <div className="stack">
        <Field label="Chemin de la source"><input value={path} onChange={e => setPath(e.target.value)} placeholder="Choisissez un fichier ou collez son chemin…" disabled={running || busy} /></Field>
        <div className="actions">
          {window.forget?.pickFile && <><button className="btn" disabled={busy || running} onClick={() => choose('export')}>Choisir un ZIP</button><button className="btn" disabled={busy || running} onClick={() => choose('engine-db')}>Base Forget Engine</button><button className="btn" disabled={busy || running} onClick={() => choose('export-dir')}>Dossier</button></>}
          <button className="btn primary" disabled={!path.trim() || busy || running || batch?.status === 'importing'} onClick={() => act(async () => { await api.post('/import/source', { path: path.trim().replace(/^"|"$/g, '') }); invalidate(); setSelected(new Set()); await source.reload(); })}>Importer</button>
        </div>
        {batch?.status === 'importing' && <Progress label={`${nf(batch.processed)} messages analysés`} indeterminate />}
        {source.error && <Notice tone="error">{source.error}</Notice>}
        {batch?.error && <Notice tone="error">{batch.error}</Notice>}
        {!!batch?.errors && <Notice tone="warn">{nf(batch.errors)} entrée(s) illisible(s) ignorée(s). Vérifiez l’aperçu du plan.</Notice>}
      </div>
    </Card>
    {batch?.status === 'ready' && <>
      <div className="grid stats"><Stat label="Messages indexés" value={nf(batch.stats.messages)} /><Stat label="Conversations" value={nf(batch.stats.channels)} /><Stat label="Sélectionnées" value={nf(selected.size)} /><Stat label="Traitement" value="Adaptatif" hint="Quotas partagés entre les opérations" /></div>
      <Card title="2. Choisir les conversations" subtitle="Seuls les messages de votre compte connecté seront supprimés après vérification.">
        <div className="stack">
          {channels.error && <Notice tone="error">{channels.error}</Notice>}
          <div className="grid-fields"><Field label="Rechercher"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Nom ou identifiant…" /></Field><Field label="Type"><select value={kind} onChange={e => setKind(e.target.value)}><option value="all">Tous les types</option><option value="dm">Messages privés</option><option value="guild">Serveurs</option><option value="unknown">Type inconnu</option></select></Field></div>
          <div className="row"><button className="btn sm" disabled={running} onClick={() => { invalidate(); setSelected(s => new Set([...s, ...list.map(c => c.cid)])); }}>Sélectionner les résultats ({list.length})</button><button className="btn sm" disabled={running || !selected.size} onClick={() => { invalidate(); setSelected(new Set()); }}>Tout désélectionner</button></div>
          <div className="conversation-table">
            {list.map(c => <label className="conversation-row" key={c.cid}><input type="checkbox" checked={selected.has(c.cid)} disabled={running} onChange={() => { invalidate(); setSelected(s => { const n = new Set(s); n.has(c.cid) ? n.delete(c.cid) : n.add(c.cid); return n; }); }} /><span className="grow"><strong>{c.name}</strong><span className="muted small"> · {c.kind === 'dm' ? 'MP' : c.kind === 'guild' ? 'Serveur' : 'Type inconnu'}</span></span><span>{nf(c.count)} messages</span></label>)}
            {!list.length && <p className="muted" style={{ padding: 16 }}>Aucune conversation ne correspond.</p>}
          </div>
          <div className="grid-fields"><Field label="Depuis le (UTC)"><input type="date" disabled={running} value={since} max={until || undefined} onChange={e => { invalidate(); setSince(e.target.value); }} /></Field><Field label="Jusqu’au (UTC)"><input type="date" disabled={running} value={until} min={since || undefined} onChange={e => { invalidate(); setUntil(e.target.value); }} /></Field></div>
          <div><button className="btn primary" disabled={busy || running || !selected.size} onClick={build}>Préparer l’aperçu</button></div>
        </div>
      </Card>
    </>}
    {plan.error && <Notice tone="error">{plan.error}</Notice>}
    {p && <Card title="3. Vérifier le plan" subtitle={`${nf(p.count)} messages ciblés · état : ${{ ready: 'prêt', running: 'en cours', done: 'terminé', failed: 'arrêté sur erreur', cancelled: 'annulé', interrupted: 'interrompu' }[p.status] || p.status}`}>
      <div className="stack">
        <div className="export-preview"><ul className="list">{plan.data.items.map(m => <li key={m.mid}><span className="muted small">{fmtDate(m.ts)} · {m.cid}</span><p>{m.content.slice(0, 220) || '(sans texte)'}</p></li>)}</ul></div>
        <p className="muted small">Aperçu des 50 premiers messages. Le contenu actuel est vérifié et archivé avant suppression ; l’export peut être ancien.</p>
        {p.error && <Notice tone="error">{p.error}</Notice>}
        <div className="execution-bar">
          <Field label="Conversations en parallèle"><select value={workers} disabled={running} onChange={e => setWorkers(Number(e.target.value))}>{[1,2,4,6,8].map(n => <option key={n} value={n}>{n} conversation{n > 1 ? 's' : ''}</option>)}</select></Field>
          {p.status === 'ready' ? <button className="btn danger-solid" disabled={busy} onClick={() => setConfirm(true)}>Supprimer {nf(p.count)} messages…</button> : <strong>{nf(plan.data.stats.deleted)} supprimés · {nf(plan.data.stats.skipped)} introuvables · {nf(plan.data.stats.failed)} échecs</strong>}
          {running && <button className="btn danger" disabled={busy} onClick={() => act(async () => { await api.post(`/import/plan/${planId}/cancel`); await plan.reload(true); })}>Arrêter le plan</button>}
        </div>
        {(plan.data.jobs || []).filter(j => ['queued','running'].includes(j.status)).map(j => <JobPanel key={j.id} id={j.id} />)}
      </div>
    </Card>}
    <Confirm open={confirm} title="Confirmer la suppression" confirmLabel="Supprimer définitivement" danger requireText="SUPPRIMER" busy={busy} onCancel={() => setConfirm(false)} onConfirm={execute}>
      <p>{nf(p?.count)} messages du plan seront vérifiés puis supprimés, dans {workers} conversations au maximum à la fois.</p>
      <Notice tone="warn">La suppression Discord est irréversible. Une copie locale du contenu actuel est conservée avant chaque suppression.</Notice>
    </Confirm>
  </>;
}
