import React, { useRef, useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, PageHeader, Field, Notice } from '../components/Card.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { nf, fmtDate, fmtDuration } from '../lib.js';

const STATUS = { running: "Running", paused: "Paused", cooldown: "Cooldown", cancelled: "Cancelled", failed: "Stopped", done: "Completed", interrupted: "Interrupted" };
const LIVE = ['running', 'paused', 'cooldown'];

// TikTok reposts: inventory from your web session, selection, local archive, then paced removal.
export default function TikTok() {
  const status = useLoad(() => api.get('/tiktok/status'), { poll: true });
  const jobs = useLoad(() => api.get('/tiktok/jobs'), { poll: true });
  const [q, setQ] = useState(''), [author, setAuthor] = useState('');
  const list = useLoad(() => api.get('/tiktok/reposts' + api.qs({ q, author, limit: 5000 })), { deps: [q, author, status.data?.count, status.data?.account?.uniqueId] });
  const [selected, setSelected] = useState(new Set());
  const [interval, setIntervalSec] = useState('4');
  const [confirm, setConfirm] = useState(null); // 'selection' | 'all'
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [info, setInfo] = useState('');
  const lastIdx = useRef(-1);

  const s = status.data || {};
  const items = list.data?.items || [];
  const running = (jobs.data || []).some((j) => LIVE.includes(j.status));
  const sec = Math.min(60, Math.max(2, Number(interval) || 4));
  const count = confirm === 'all' ? s.count || 0 : selected.size;

  async function act(fn) { setBusy(true); setError(''); setInfo(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const refresh = async () => { await Promise.all([status.reload(true), jobs.reload(true), list.reload(true)]); };
  function toggle(idx, shift) {
    const a = shift && lastIdx.current >= 0 ? Math.min(lastIdx.current, idx) : idx;
    const b = shift && lastIdx.current >= 0 ? Math.max(lastIdx.current, idx) : idx;
    setSelected((prev) => {
      const next = new Set(prev), on = !next.has(items[idx].id);
      for (const it of items.slice(a, b + 1)) (on ? next.add(it.id) : next.delete(it.id));
      return next;
    });
    lastIdx.current = idx;
  }

  return (
    <>
      <PageHeader title="TikTok" subtitle="Reposts · inventory, selection, local archive, and paced removal." />
      {(error || status.error) && <Notice tone="error">{error || status.error}</Notice>}
      {info && <Notice tone="info">{info}</Notice>}
      <Card title="1. Your TikTok session" subtitle="Forget opens tiktok.com in an isolated window for you to log in.">
        <div className="stack">
          <Notice tone="warn">
            TikTok has no official API for reposts. Forget uses the same requests as the website in your own session.
            These requests are undocumented and may stop working. Automation may violate TikTok’s terms of service. Use only your own account, at your own risk.
          </Notice>
          {!s.available && status.data && <Notice>Available only in the desktop app.</Notice>}
          {s.available && !s.online && <Notice>Disable offline mode in Settings → Privacy.</Notice>}
          <div className="row wrap">
            <button className="btn primary" disabled={busy || !s.available || !s.online} onClick={() => act(async () => { await api.post('/tiktok/window'); setInfo("Window open: log in, then click \"Verify session\"."); await status.reload(true); })}>
              {s.windowOpen ? "Show TikTok window" : "Open TikTok"}
            </button>
            <button className="btn" disabled={busy || !s.windowOpen} onClick={() => act(async () => { const a = await api.post('/tiktok/session'); setInfo(`Session verified${a.uniqueId ? `: @${a.uniqueId}` : ''}.`); await refresh(); })}>Verify session</button>
            <span className="grow muted small">{s.account ? `Account: ${s.account.uniqueId ? '@' + s.account.uniqueId : s.account.nickname || "connected"}` : "No verified session."}</span>
          </div>
        </div>
      </Card>

      <Card title="2. Repost inventory" subtitle="Read page by page (30 items), with a pause between pages.">
        <div className="stack">
          <div className="row wrap">
            <button className="btn primary" disabled={busy || running || !s.windowOpen} onClick={() => act(async () => { await api.post('/tiktok/scan'); setSelected(new Set()); await refresh(); })}>
              {s.count ? "Refresh inventory" : "Start inventory"}
            </button>
            <span className="muted small">{nf(s.count)} known reposts · {nf(selected.size)} selected</span>
          </div>
          <div className="grid-fields">
            <Field label="Description contains"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="word, #hashtag…" /></Field>
            <Field label="Video author"><input type="search" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="@username" /></Field>
          </div>
          <div className="row wrap">
            <button className="btn sm" disabled={running || !items.length} onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Select results ({nf(items.length)})</button>
            <button className="btn sm" disabled={running || !items.length} onClick={() => setSelected((p) => { const n = new Set(p); items.forEach((i) => (n.has(i.id) ? n.delete(i.id) : n.add(i.id))); return n; })}>Invert selection</button>
            <button className="btn sm" disabled={running || !selected.size} onClick={() => setSelected(new Set())}>Deselect all</button>
            <span className="muted small">Shift+click to select a range.</span>
          </div>
          <div className="conversation-table">
            {items.map((it, idx) => (
              <label className="conversation-row" key={it.id} onClick={(e) => { e.preventDefault(); if (!running) toggle(idx, e.shiftKey); }}>
                <input type="checkbox" checked={selected.has(it.id)} disabled={running} readOnly />
                <span className="grow">
                  <span className="muted small">@{it.author || '?'}{it.createTime ? ` · posted on ${fmtDate(it.createTime * 1000)}` : ''}</span>
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{it.desc || "(no description)"}</p>
                </span>
              </label>
            ))}
            {list.data && !items.length && <p style={{ padding: 16 }} className="muted">{s.count ? "No reposts match these filters." : "Start the inventory to list your reposts."}</p>}
          </div>
        </div>
      </Card>

      <Card title="3. Remove reposts" subtitle="Local archive before each removal; one request at a time, at a fixed pace.">
        <div className="stack">
          <Field label="Interval between removals (seconds)" hint={`Between 2 and 60 s. Estimated duration: ${fmtDuration(sec * Math.max(count || selected.size, 0))}. If TikTok rejects a request: pause for ${s.defaults?.cooldownMin ?? 15} min; stop after 3 consecutive rejections.`}>
            <input type="number" min="2" max="60" value={interval} onChange={(e) => setIntervalSec(e.target.value)} />
          </Field>
          <div className="actions">
            <button className="btn danger-solid" disabled={busy || running || !selected.size} onClick={() => setConfirm('selection')}>Remove {nf(selected.size)} reposts…</button>
            <button className="btn danger" disabled={busy || running || !s.count} onClick={() => setConfirm('all')}>Remove all ({nf(s.count)})…</button>
          </div>
        </div>
      </Card>

      {(jobs.data || []).length > 0 && (
        <Card title="Operation progress">
          <div className="stack">
            {(jobs.data || []).map((j) => (
              <div className="job" key={j.id}>
                <div className="row wrap">
                  <strong>{j.kind === 'scan' ? "Inventory" : "Removal"} · {STATUS[j.status] || j.status}</strong>
                  <span className="grow">{j.kind === 'scan' ? `${nf(j.done)} found` : `${nf(j.done)}/${nf(j.total)} removed · ${nf(j.failed)} skipped`}{j.status === 'cooldown' && j.waitUntil ? ` · resumes around ${fmtDate(j.waitUntil)}` : ''}</span>
                  {LIVE.includes(j.status) && (
                    <>
                      <button className="btn sm" disabled={busy} onClick={() => act(async () => { await api.post(`/tiktok/jobs/${j.id}/${j.status === 'paused' ? 'resume' : 'pause'}`); await jobs.reload(true); })}>{j.status === 'paused' ? "Resume" : 'Pause'}</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => act(async () => { await api.post(`/tiktok/jobs/${j.id}/cancel`); await refresh(); })}>Stop</button>
                    </>
                  )}
                </div>
                {j.kind === 'remove' && <Progress value={j.done} max={j.total} label="Removal progress" />}
                {j.error && <Notice tone="error">{j.error}</Notice>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Confirm open={!!confirm} title="Remove these reposts?" confirmLabel="Remove" danger requireText="REMOVE" busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act(async () => {
          await api.post('/tiktok/jobs', { ...(confirm === 'all' ? { all: true } : { ids: [...selected] }), confirm: true, intervalSec: sec });
          setConfirm(null); setSelected(new Set()); await refresh();
        })}>
        <p>{nf(count)} reposts from your account, one every {sec} s (about {fmtDuration(sec * count)}).</p>
        <Notice tone="warn">Original videos are unchanged; only your repost is removed. The description and link are archived locally before each removal.</Notice>
      </Confirm>
    </>
  );
}
