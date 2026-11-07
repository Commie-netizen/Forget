import React, { useRef, useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, PageHeader, Field, Notice } from '../components/Card.jsx';
import { Confirm } from '../components/Modal.jsx';
import Progress from '../components/Progress.jsx';
import { nf, fmtDate, fmtDuration } from '../lib.js';

const STATUS = { running: 'En cours', paused: 'En pause', cooldown: 'Refroidissement', cancelled: 'Annulé', failed: 'Arrêté', done: 'Terminé', interrupted: 'Interrompu' };
const LIVE = ['running', 'paused', 'cooldown'];

// Republications TikTok : inventaire depuis votre session web, sélection, archive locale puis retrait cadencé.
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
      <PageHeader title="TikTok" subtitle="Republications (reposts) · inventaire, sélection, archive locale et retrait cadencé." />
      {(error || status.error) && <Notice tone="error">{error || status.error}</Notice>}
      {info && <Notice tone="info">{info}</Notice>}
      <Card title="1. Votre session TikTok" subtitle="Forget ouvre tiktok.com dans une fenêtre isolée ; vous vous connectez vous-même.">
        <div className="stack">
          <Notice tone="warn">
            TikTok ne propose aucune API officielle pour les republications. Forget utilise, dans votre propre session, les mêmes requêtes que le site web.
            Elles ne sont pas documentées et peuvent cesser de fonctionner. L’automatisation peut enfreindre les conditions d’utilisation de TikTok : à utiliser sur votre compte, à vos risques.
          </Notice>
          {!s.available && status.data && <Notice>Disponible dans l’application de bureau uniquement.</Notice>}
          {s.available && !s.online && <Notice>Désactivez le mode hors-ligne dans Réglages → Confidentialité.</Notice>}
          <div className="row wrap">
            <button className="btn primary" disabled={busy || !s.available || !s.online} onClick={() => act(async () => { await api.post('/tiktok/window'); setInfo('Fenêtre ouverte : connectez-vous, puis cliquez sur « Vérifier la session ».'); await status.reload(true); })}>
              {s.windowOpen ? 'Afficher la fenêtre TikTok' : 'Ouvrir TikTok'}
            </button>
            <button className="btn" disabled={busy || !s.windowOpen} onClick={() => act(async () => { const a = await api.post('/tiktok/session'); setInfo(`Session vérifiée${a.uniqueId ? ` : @${a.uniqueId}` : ''}.`); await refresh(); })}>Vérifier la session</button>
            <span className="grow muted small">{s.account ? `Compte : ${s.account.uniqueId ? '@' + s.account.uniqueId : s.account.nickname || 'connecté'}` : 'Aucune session vérifiée.'}</span>
          </div>
        </div>
      </Card>

      <Card title="2. Inventaire de vos republications" subtitle="Lecture page par page (30 éléments), avec pause entre les pages.">
        <div className="stack">
          <div className="row wrap">
            <button className="btn primary" disabled={busy || running || !s.windowOpen} onClick={() => act(async () => { await api.post('/tiktok/scan'); setSelected(new Set()); await refresh(); })}>
              {s.count ? 'Relancer l’inventaire' : 'Lancer l’inventaire'}
            </button>
            <span className="muted small">{nf(s.count)} republication(s) connue(s) · {nf(selected.size)} sélectionnée(s)</span>
          </div>
          <div className="grid-fields">
            <Field label="Description contient"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="mot, #hashtag…" /></Field>
            <Field label="Auteur de la vidéo"><input type="search" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="@pseudo" /></Field>
          </div>
          <div className="row wrap">
            <button className="btn sm" disabled={running || !items.length} onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Sélectionner les résultats ({nf(items.length)})</button>
            <button className="btn sm" disabled={running || !items.length} onClick={() => setSelected((p) => { const n = new Set(p); items.forEach((i) => (n.has(i.id) ? n.delete(i.id) : n.add(i.id))); return n; })}>Inverser</button>
            <button className="btn sm" disabled={running || !selected.size} onClick={() => setSelected(new Set())}>Tout désélectionner</button>
            <span className="muted small">Maj+clic : sélection d’une plage.</span>
          </div>
          <div className="conversation-table">
            {items.map((it, idx) => (
              <label className="conversation-row" key={it.id} onClick={(e) => { e.preventDefault(); if (!running) toggle(idx, e.shiftKey); }}>
                <input type="checkbox" checked={selected.has(it.id)} disabled={running} readOnly />
                <span className="grow">
                  <span className="muted small">@{it.author || '?'}{it.createTime ? ` · publiée le ${fmtDate(it.createTime * 1000)}` : ''}</span>
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{it.desc || '(sans description)'}</p>
                </span>
              </label>
            ))}
            {list.data && !items.length && <p style={{ padding: 16 }} className="muted">{s.count ? 'Aucune republication pour ces filtres.' : 'Lancez l’inventaire pour lister vos republications.'}</p>}
          </div>
        </div>
      </Card>

      <Card title="3. Retirer les republications" subtitle="Archive locale avant chaque retrait ; une requête à la fois, à cadence fixe.">
        <div className="stack">
          <Field label="Intervalle entre deux retraits (secondes)" hint={`Entre 2 et 60 s. Durée estimée : ${fmtDuration(sec * Math.max(count || selected.size, 0))}. En cas de refus de TikTok : pause de ${s.defaults?.cooldownMin ?? 15} min, arrêt après 3 refus consécutifs.`}>
            <input type="number" min="2" max="60" value={interval} onChange={(e) => setIntervalSec(e.target.value)} />
          </Field>
          <div className="actions">
            <button className="btn danger-solid" disabled={busy || running || !selected.size} onClick={() => setConfirm('selection')}>Retirer {nf(selected.size)} republication(s)…</button>
            <button className="btn danger" disabled={busy || running || !s.count} onClick={() => setConfirm('all')}>Tout retirer ({nf(s.count)})…</button>
          </div>
        </div>
      </Card>

      {(jobs.data || []).length > 0 && (
        <Card title="Suivi des opérations">
          <div className="stack">
            {(jobs.data || []).map((j) => (
              <div className="job" key={j.id}>
                <div className="row wrap">
                  <strong>{j.kind === 'scan' ? 'Inventaire' : 'Retrait'} · {STATUS[j.status] || j.status}</strong>
                  <span className="grow">{j.kind === 'scan' ? `${nf(j.done)} trouvée(s)` : `${nf(j.done)}/${nf(j.total)} retirée(s) · ${nf(j.failed)} ignorée(s)`}{j.status === 'cooldown' && j.waitUntil ? ` · reprise vers ${fmtDate(j.waitUntil)}` : ''}</span>
                  {LIVE.includes(j.status) && (
                    <>
                      <button className="btn sm" disabled={busy} onClick={() => act(async () => { await api.post(`/tiktok/jobs/${j.id}/${j.status === 'paused' ? 'resume' : 'pause'}`); await jobs.reload(true); })}>{j.status === 'paused' ? 'Reprendre' : 'Pause'}</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => act(async () => { await api.post(`/tiktok/jobs/${j.id}/cancel`); await refresh(); })}>Arrêter</button>
                    </>
                  )}
                </div>
                {j.kind === 'remove' && <Progress value={j.done} max={j.total} label="Progression du retrait" />}
                {j.error && <Notice tone="error">{j.error}</Notice>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Confirm open={!!confirm} title="Retirer ces republications ?" confirmLabel="Retirer" danger requireText="RETIRER" busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act(async () => {
          await api.post('/tiktok/jobs', { ...(confirm === 'all' ? { all: true } : { ids: [...selected] }), confirm: true, intervalSec: sec });
          setConfirm(null); setSelected(new Set()); await refresh();
        })}>
        <p>{nf(count)} republication(s) de votre compte, une toutes les {sec} s (environ {fmtDuration(sec * count)}).</p>
        <Notice tone="warn">Les vidéos d’origine ne sont pas touchées : seule votre republication est retirée. La description et le lien sont archivés localement avant chaque retrait.</Notice>
      </Confirm>
    </>
  );
}
