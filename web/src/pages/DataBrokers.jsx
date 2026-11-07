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
  ['submit', "Submission"],
  ['verify', "Verification"],
  ['poll', "Follow-up"],
  ['done', "Completed"],
];

function Timeline({ steps }) {
  const done = new Map((steps || []).map((s) => [s.type || s.name, s]));
  return (
    <ol className="timeline" aria-label="Removal steps">
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
      <dd>{items.join("; ")}</dd>
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
          <strong>{names.join(', ') || "Unknown identity"}</strong>
          {result.age != null && <span className="muted"> · {result.age} years old</span>}
          {result.profileUrl && (
            <div className="small ellipsis">
              {/^https?:\/\//i.test(String(result.profileUrl)) /* never link to javascript: or data: URLs */
                ? <a href={result.profileUrl} target="_blank" rel="noopener noreferrer">{result.profileUrl}</a>
                : <span>{String(result.profileUrl)}</span>}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "View details"}
          </button>
          {removal ? (
            <StatusBadge value={removal.status} />
          ) : (
            <button type="button" className="btn sm danger-solid" disabled={busy} onClick={() => onRemove(result)}>
              Request removal
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="result-detail">
          <dl className="kv-block">
            <Row label="Identity" items={names} />
            <Row label="Addresses" items={toList(result.addresses)} />
            <Row label="Emails" items={toList(result.emails)} />
            <Row label="Phone numbers" items={toList(result.phones)} />
            <Row label="Relatives" items={toList(result.relatives)} />
            {extras && typeof extras === 'object' && Object.entries(extras).map(([k, v]) => (
              <Row key={k} label={k} items={toList(v).length ? toList(v) : [String(v)]} />
            ))}
          </dl>
          <h4 className="sub-title">Evidence</h4>
          {detail.loading ? (
            <Spinner />
          ) : shots.length === 0 ? (
            <p className="muted small">No screenshots available.</p>
          ) : (
            <div className="shots">
              {shots.map((s) => (
                <figure key={s.id}>
                  {typeof s.data === 'string' && s.data.startsWith('data:image/') ? (
                    <img src={s.data} alt={s.label || "Screenshot"} />
                  ) : (
                    <div className="shot-ph">Screenshot</div>
                  )}
                  <figcaption className="muted small">{s.label || s.kind || "Screenshot"}</figcaption>
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

  // Bulk scan progress: lightweight list of all jobs (without details), refreshed every 1500 ms.
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
        notice: api.isMissingEndpoint(e) ? "Bulk scanning is unavailable on this server." : '',
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
    ['catalog', `Catalog (${nf(clawList.length)})`],
    ['results', `Results (${resultCount})`],
    ['removals', `Removals (${removals.length})`],
  ];

  return (
    <>
      <PageHeader
        title="Data Brokers"
        subtitle="Find and request removal of your personal information."
        actions={<Badge tone="blue">Beta</Badge>}
      />
      <Notice tone="error">{error || claws.error || jobs.error}</Notice>
      {!activeProfile && (
        <Notice
          tone="warn"
          title="No active profile"
          action={<button type="button" className="btn sm" onClick={() => navigate('profiles')}>Create a profile</button>}
        >
          A profile is required to start a scan.
        </Notice>
      )}
      {activeProfile && <p className="muted small">Active profile: <strong>{activeProfile.primaryName}</strong> · <button type="button" className="link" onClick={() => navigate('profiles')}>Change</button></p>}

      <div className="tabs" role="tablist" aria-label="Data Brokers sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'catalog' && (
        <>
          <div className="row wrap">
            <p className="grow" role="status">
              <strong>{nf(clawList.length)}</strong> data brokers available
              {(cat || filter) && <> · <strong>{nf(shown.length)}</strong> shown</>}
              {' '}· no scan limit.
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={!activeProfile || scanAll.busy || batchRunning || clawList.length === 0}
              onClick={runScanAll}
            >
              {scanAll.busy ? "Starting..." : "Scan all brokers"}
            </button>
          </div>
          {scanAll.notice && <Notice tone="warn">{scanAll.notice}</Notice>}
          {scanAll.jobIds.length > 0 && (
            <div className="stack">
              <Progress label="Bulk scan progress" value={batchDone} max={Math.max(batchTotal, 1)} tone={batchRunning ? 'blue' : 'green'} />
              <p className="muted small" role="status" aria-live="polite">
                {nf(batchDone)} / {nf(batchTotal)} completed{batchRunning ? '' : " · bulk scan complete"}.
                {' '}<button type="button" className="link" onClick={() => setTab('results')}>View results</button>
              </p>
            </div>
          )}
          <div className="filters">
            <label className="search-input">
              <span className="sr-only">Filter the catalog</span>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or website..." />
            </label>
            <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories ({nf(clawList.length)})</option>
              {categories.map((c) => <option key={c} value={c}>{c} ({nf(clawList.filter((x) => x.category === c).length)})</option>)}
            </select>
          </div>
          {claws.loading && !claws.data ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <EmptyState icon="shield" title="No data brokers">No results in the catalog.</EmptyState>
          ) : (
            <div className="grid cards">
              {shown.map((c) => (
                <article className="card" key={c.id}>
                  <div className="row"><strong className="grow">{c.name}</strong><Badge>{c.category}</Badge></div>
                  <div className="muted small">{c.website}</div>
                  <p className="small">{c.description}</p>
                  <button type="button" className="btn sm primary" disabled={!activeProfile || pending === c.id || c.enabled === 0} onClick={() => scan(c)}>
                    {pending === c.id ? "Starting..." : "Scan"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'results' &&
        (scans.length === 0 ? (
          <EmptyState icon="search" title="No scans started">Start a scan from the catalog.</EmptyState>
        ) : (
          <div className="stack">
            {scans.map((j) => (
              <Card key={j.id} as="article">
                <div className="row">
                  <strong className="grow">{clawName(j.clawId)}</strong>
                  <StatusBadge value={j.status} />
                </div>
                <div className="muted small">Created on {fmtDate(j.createdAt)}{j.failure ? ` · ${j.failure}` : ''}</div>
                {isActive(j.status) && <p className="muted small">Scanning...</p>}
                {j.results?.length > 0 && (
                  <div className="results">
                    {j.results.map((r) => (
                      <ResultCard key={r.id} result={r} removal={removalByResult.get(r.id)} onRemove={setConfirmRes} busy={pending === r.id} />
                    ))}
                  </div>
                )}
                {j.status === 'succeeded' && j.results?.length === 0 && <p className="muted small">No data about you found.</p>}
              </Card>
            ))}
          </div>
        ))}

      {tab === 'removals' &&
        (removals.length === 0 ? (
          <EmptyState icon="trash" title="No removals requested">Request removal from a result.</EmptyState>
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
        title="Request removal?"
        confirmLabel="Send request"
        busy={!!pending}
        onCancel={() => setConfirmRes(null)}
        onConfirm={remove}
      >
        <p>A removal request for the entry "{toList(confirmRes?.names).join(', ') || "unknown identity"}" will be sent to the relevant data broker.</p>
      </Confirm>
    </>
  );
}
