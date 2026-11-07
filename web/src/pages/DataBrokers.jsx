import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Spinner } from '../components/Card.jsx';
import Badge, { StatusBadge } from '../components/Badge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { fmtDate, isActive, nf, toList } from '../lib.js';

const STEP_TYPES = [
  ['submit', 'Soumission'],
  ['verify', 'Vérification'],
  ['poll', 'Suivi'],
  ['done', 'Terminé'],
];

function Timeline({ steps }) {
  const done = new Map((steps || []).map((s) => [s.type || s.name, s]));
  return (
    <ol className="timeline" aria-label="Étapes de suppression">
      {STEP_TYPES.map(([type, label]) => {
        const s = done.get(type);
        return (
          <li key={type} className={s ? 'done' : ''}>
            <span className="tl-dot" aria-hidden="true" />
            <span>{label}</span>
            {s && <span className="muted small">{fmtDate(s.updatedAt || s.createdAt)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Row({ label, items }) {
  if (!items.length) return null;
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{items.join(' ; ')}</dd>
    </div>
  );
}

function ResultCard({ result, removal, onRemove, busy }) {
  const [open, setOpen] = useState(false);
  const detail = useLoad(() => api.getScanResult(result.id), { enabled: open, deps: [open, result.id] });
  const names = toList(result.names);
  const shots = Array.isArray(detail.data?.screenshots) ? detail.data.screenshots : [];
  let extras = null;
  try {
    extras = typeof result.extras === 'string' && result.extras ? JSON.parse(result.extras) : result.extras;
  } catch {
    extras = null;
  }
  return (
    <div className="result">
      <div className="row wrap">
        <div className="grow">
          <strong>{names.join(', ') || 'Identité inconnue'}</strong>
          {result.age != null && <span className="muted"> · {result.age} ans</span>}
          {result.profileUrl && (
            <div className="small ellipsis">
              {/^https?:\/\//i.test(String(result.profileUrl)) /* jamais de lien javascript: ou data: */
                ? <a href={result.profileUrl} target="_blank" rel="noopener noreferrer">{result.profileUrl}</a>
                : <span>{String(result.profileUrl)}</span>}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Masquer le détail' : 'Voir le détail'}
          </button>
          {removal ? (
            <StatusBadge value={removal.status} />
          ) : (
            <button type="button" className="btn sm danger-solid" disabled={busy} onClick={() => onRemove(result)}>
              Demander la suppression
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="result-detail">
          <dl className="kv-block">
            <Row label="Identité" items={names} />
            <Row label="Adresses" items={toList(result.addresses)} />
            <Row label="E-mails" items={toList(result.emails)} />
            <Row label="Téléphones" items={toList(result.phones)} />
            <Row label="Proches" items={toList(result.relatives)} />
            {extras && typeof extras === 'object' && Object.entries(extras).map(([k, v]) => (
              <Row key={k} label={k} items={toList(v).length ? toList(v) : [String(v)]} />
            ))}
          </dl>
          <h4 className="sub-title">Preuves</h4>
          {detail.loading ? (
            <Spinner />
          ) : shots.length === 0 ? (
            <p className="muted small">Aucune capture disponible.</p>
          ) : (
            <div className="shots">
              {shots.map((s) => (
                <figure key={s.id}>
                  {typeof s.data === 'string' && s.data.startsWith('data:image/') ? (
                    <img src={s.data} alt={s.label || 'Capture'} />
                  ) : (
                    <div className="shot-ph">Capture</div>
                  )}
                  <figcaption className="muted small">{s.label || s.kind || 'Capture'}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataBrokers() {
  const { activeProfile, navigate } = useApp();
  const [tab, setTab] = useState('catalog');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [filter, setFilter] = useState('');
  const [cat, setCat] = useState('');
  const [confirmRes, setConfirmRes] = useState(null);
  const [scanAll, setScanAll] = useState({ busy: false, total: 0, jobIds: [], notice: '' });

  const claws = useLoad(() => api.listClaws());
  const jobs = useLoad(
    async () => {
      const [scanList, removalList] = await Promise.all([api.listScanJobs(), api.listRemovalJobs()]);
      const scans = await Promise.all(scanList.slice(0, 15).map((j) => api.getScanJob(j.id).catch(() => j)));
      const removals = await Promise.all(removalList.slice(0, 15).map((j) => api.getRemovalJob(j.id).catch(() => j)));
      return { scans, removals };
    },
    { poll: (d) => !!d && (d.scans.some((j) => isActive(j.status)) || d.removals.some((j) => isActive(j.status))) }
  );

  // Progression du scan massif : liste légère de tous les jobs (sans détail), rafraîchie toutes les 1500 ms.
  const allJobs = useLoad(() => api.listScanJobs(), {
    poll: (d) => scanAll.jobIds.length > 0 && (!Array.isArray(d) || d.some((j) => scanAll.jobIds.includes(j.id) && isActive(j.status))),
  });

  const clawList = Array.isArray(claws.data) ? claws.data : [];
  const categories = [...new Set(clawList.map((c) => c.category).filter(Boolean))];
  const shown = clawList.filter(
    (c) => (!cat || c.category === cat) && (!filter || `${c.name} ${c.website} ${c.description}`.toLowerCase().includes(filter.toLowerCase()))
  );
  const clawName = (id) => clawList.find((c) => c.id === id)?.name || id;
  const scans = jobs.data?.scans || [];
  const removals = jobs.data?.removals || [];
  const removalByResult = new Map(removals.map((r) => [r.scanResultId, r]));
  const resultCount = scans.reduce((n, j) => n + (j.results?.length || 0), 0);

  async function scan(claw) {
    if (!activeProfile) return;
    setPending(claw.id);
    setError('');
    try {
      await api.scanClaw(claw.id, activeProfile.id);
      await jobs.reload(true);
      setTab('results');
    } catch (e) {
      setError(e.message);
    } finally {
      setPending('');
    }
  }

  const batchSet = new Set(scanAll.jobIds);
  const batchJobs = (Array.isArray(allJobs.data) ? allJobs.data : []).filter((j) => batchSet.has(j.id));
  const batchDone = batchJobs.filter((j) => !isActive(j.status)).length;
  const batchTotal = scanAll.total || scanAll.jobIds.length;
  const batchRunning = scanAll.jobIds.length > 0 && batchDone < batchTotal;

  async function runScanAll() {
    if (!activeProfile) return;
    setScanAll((s) => ({ ...s, busy: true, notice: '' }));
    setError('');
    try {
      const r = await api.scanAllClaws(activeProfile.id);
      const jobIds = Array.isArray(r?.jobIds) ? r.jobIds : [];
      setScanAll({ busy: false, total: r?.total ?? jobIds.length, jobIds, notice: '' });
      await Promise.all([allJobs.reload(true), jobs.reload(true)]);
    } catch (e) {
      setScanAll((s) => ({
        ...s,
        busy: false,
        notice: api.isMissingEndpoint(e) ? 'Le scan massif n’est pas disponible sur ce serveur.' : '',
      }));
      if (!api.isMissingEndpoint(e)) setError(e.message);
    }
  }

  async function remove() {
    const r = confirmRes;
    setPending(r.id);
    setError('');
    try {
      await api.requestRemoval(r.id);
      setConfirmRes(null);
      await jobs.reload(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending('');
    }
  }

  const tabs = [
    ['catalog', `Catalogue (${nf(clawList.length)})`],
    ['results', `Résultats (${resultCount})`],
    ['removals', `Suppressions (${removals.length})`],
  ];

  return (
    <>
      <PageHeader
        title="Data Brokers"
        subtitle="Trouvez et faites retirer vos informations personnelles."
        actions={<Badge tone="blue">Beta</Badge>}
      />
      <Notice tone="error">{error || claws.error || jobs.error}</Notice>
      {!activeProfile && (
        <Notice
          tone="warn"
          title="Aucun profil actif"
          action={<button type="button" className="btn sm" onClick={() => navigate('profiles')}>Créer un profil</button>}
        >
          Un profil est nécessaire pour lancer un scan.
        </Notice>
      )}
      {activeProfile && <p className="muted small">Profil actif : <strong>{activeProfile.primaryName}</strong> · <button type="button" className="link" onClick={() => navigate('profiles')}>Changer</button></p>}

      <div className="tabs" role="tablist" aria-label="Sections Data Brokers">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'catalog' && (
        <>
          <div className="row wrap">
            <p className="grow" role="status">
              <strong>{nf(clawList.length)}</strong> data broker(s) disponible(s)
              {(cat || filter) && <> · <strong>{nf(shown.length)}</strong> affiché(s)</>}
              {' '}· aucun maximum de scan.
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={!activeProfile || scanAll.busy || batchRunning || clawList.length === 0}
              onClick={runScanAll}
            >
              {scanAll.busy ? 'Lancement...' : 'Scanner tous les brokers'}
            </button>
          </div>
          {scanAll.notice && <Notice tone="warn">{scanAll.notice}</Notice>}
          {scanAll.jobIds.length > 0 && (
            <div className="stack">
              <Progress label="Progression du scan massif" value={batchDone} max={Math.max(batchTotal, 1)} tone={batchRunning ? 'blue' : 'green'} />
              <p className="muted small" role="status" aria-live="polite">
                {nf(batchDone)} / {nf(batchTotal)} terminé(s){batchRunning ? '' : ' · scan massif terminé'}.
                {' '}<button type="button" className="link" onClick={() => setTab('results')}>Voir les résultats</button>
              </p>
            </div>
          )}
          <div className="filters">
            <label className="search-input">
              <span className="sr-only">Filtrer le catalogue</span>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer par nom ou site..." />
            </label>
            <select aria-label="Catégorie" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Toutes les catégories ({nf(clawList.length)})</option>
              {categories.map((c) => <option key={c} value={c}>{c} ({nf(clawList.filter((x) => x.category === c).length)})</option>)}
            </select>
          </div>
          {claws.loading && !claws.data ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <EmptyState icon="shield" title="Aucun data broker">Aucun résultat dans le catalogue.</EmptyState>
          ) : (
            <div className="grid cards">
              {shown.map((c) => (
                <article className="card" key={c.id}>
                  <div className="row"><strong className="grow">{c.name}</strong><Badge>{c.category}</Badge></div>
                  <div className="muted small">{c.website}</div>
                  <p className="small">{c.description}</p>
                  <button type="button" className="btn sm primary" disabled={!activeProfile || pending === c.id || c.enabled === 0} onClick={() => scan(c)}>
                    {pending === c.id ? 'Lancement...' : 'Scanner'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'results' &&
        (scans.length === 0 ? (
          <EmptyState icon="search" title="Aucun scan lancé">Lancez un scan depuis le catalogue.</EmptyState>
        ) : (
          <div className="stack">
            {scans.map((j) => (
              <Card key={j.id} as="article">
                <div className="row">
                  <strong className="grow">{clawName(j.clawId)}</strong>
                  <StatusBadge value={j.status} />
                </div>
                <div className="muted small">Créé le {fmtDate(j.createdAt)}{j.failure ? ` · ${j.failure}` : ''}</div>
                {isActive(j.status) && <p className="muted small">Scan en cours...</p>}
                {j.results?.length > 0 && (
                  <div className="results">
                    {j.results.map((r) => (
                      <ResultCard key={r.id} result={r} removal={removalByResult.get(r.id)} onRemove={setConfirmRes} busy={pending === r.id} />
                    ))}
                  </div>
                )}
                {j.status === 'succeeded' && j.results?.length === 0 && <p className="muted small">Aucune donnée vous concernant trouvée.</p>}
              </Card>
            ))}
          </div>
        ))}

      {tab === 'removals' &&
        (removals.length === 0 ? (
          <EmptyState icon="trash" title="Aucune suppression demandée">Demandez la suppression depuis un résultat.</EmptyState>
        ) : (
          <div className="stack">
            {removals.map((r) => (
              <Card key={r.id} as="article">
                <div className="row">
                  <strong className="grow">{clawName(r.clawId)}</strong>
                  <StatusBadge value={r.status} />
                </div>
                <Timeline steps={r.steps} />
                {r.failure && <div className="muted small">{r.failure}</div>}
              </Card>
            ))}
          </div>
        ))}

      <Confirm
        open={!!confirmRes}
        title="Demander la suppression ?"
        confirmLabel="Envoyer la demande"
        busy={!!pending}
        onCancel={() => setConfirmRes(null)}
        onConfirm={remove}
      >
        <p>Une demande de retrait sera envoyée pour l’entrée « {toList(confirmRes?.names).join(', ') || 'identité inconnue'} » auprès du data broker concerné.</p>
      </Confirm>
    </>
  );
}
