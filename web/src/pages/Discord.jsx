import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Field } from '../components/Card.jsx';
import DiscordGate from '../components/DiscordGate.jsx';
import Select from '../components/Select.jsx';
import Slider from '../components/Slider.jsx';
import Progress from '../components/Progress.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { StatusBadge } from '../components/Badge.jsx';
import { Confirm } from '../components/Modal.jsx';
import Icon from '../components/Icon.jsx';
import {
  dayEndMs, dayStartMs, fmtDate, fmtDuration, isActive, msgAuthor, msgDate, msgText, matches, nf, toSnowflake,
} from '../lib.js';

const SPEEDS = {
  adaptive: { label: 'Adaptatif', desc: 'Cadence ajustée aux quotas Discord. Quotas partagés entre toutes les opérations.', delayMs: 0, concurrency: 4 },
  safe: { label: 'Prudent', desc: 'Au moins 900 ms entre opérations, en respectant les quotas Discord.', delayMs: 900, concurrency: 1 },
  fast: { label: 'Rapide', desc: 'Au moins 300 ms entre opérations, en respectant les quotas Discord.', delayMs: 300, concurrency: 2 },
  custom: { label: 'Personnalisé', desc: 'Réglez vous-même le délai et la concurrence.' },
};

const EDIT_MODES = [
  { value: 'replace', label: 'Remplacer un texte' },
  { value: 'set', label: 'Remplacer tout le contenu' },
  { value: 'append', label: 'Ajouter à la fin' },
  { value: 'prepend', label: 'Ajouter au début' },
];

function SpeedPicker({ speed, setSpeed }) {
  const preset = SPEEDS[speed.mode];
  return (
    <fieldset className="fieldset">
      <legend className="field-label">Vitesse</legend>
      <div className="segmented" role="radiogroup" aria-label="Vitesse d’exécution">
        {Object.entries(SPEEDS).map(([id, s]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={speed.mode === id}
            className={speed.mode === id ? 'on' : ''}
            onClick={() => setSpeed({ ...speed, mode: id })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="muted small">{preset.desc}</p>
      {speed.mode === 'custom' && (
        <div className="two-col">
          <Slider label="Délai entre requêtes" unit=" ms" min={150} max={2000} step={50} value={speed.delayMs} onChange={(v) => setSpeed({ ...speed, delayMs: v })} />
          <Slider label="Concurrence" min={1} max={4} step={1} value={speed.concurrency} onChange={(v) => setSpeed({ ...speed, concurrency: v })} />
        </div>
      )}
    </fieldset>
  );
}

function speedBody(speed) {
  return speed.mode === 'custom'
    ? { mode: 'custom', delayMs: speed.delayMs, concurrency: speed.concurrency }
    : { mode: speed.mode };
}
function speedParams(speed) {
  return speed.mode === 'custom' ? speed : { ...speed, ...SPEEDS[speed.mode] };
}

export function JobPanel({ id, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const job = useLoad(() => api.discordJob(id), { deps: [id], poll: (d) => !d || isActive(d.status) });
  const j = job.data;

  async function cancel() {
    setBusy(true);
    setErr('');
    try {
      await api.discordCancelJob(id);
      await job.reload(true);
      onCancelled?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!j) return job.error ? <Notice tone="error">{job.error}</Notice> : <p className="muted small">Chargement du job...</p>;
  const active = isActive(j.status);
  const done = (j.deleted || 0) + (j.edited || 0) + (j.failed || 0);
  const progress = j.progress ?? done;
  const logs = Array.isArray(j.logs) ? j.logs.slice(-8) : [];
  const elapsed = j.startedAt ? Math.max(1, ((j.finishedAt || Date.now()) - j.startedAt) / 1000) : 0;
  const rate = elapsed ? ((j.deleted || 0) + (j.edited || 0)) / elapsed : 0;
  return (
    <div className="job">
      <div className="row">
        <strong>{j.kind === 'edit' ? 'Édition en masse' : 'Suppression en masse'}</strong>
        {j.params?.channelId && <span className="muted small">{j.params.channelName || j.params.channelId}</span>}
        <StatusBadge value={j.status} />
        <span className="grow" />
        {active && (
          <button type="button" className="btn sm danger" disabled={busy || j.cancelRequested} onClick={cancel}>
            {j.cancelRequested ? 'Annulation demandée...' : 'Annuler'}
          </button>
        )}
      </div>
      <Progress
        label="Progression du job"
        value={progress}
        max={j.total || Math.max(progress, 1)}
        tone={j.status === 'failed' ? 'red' : j.status === 'done' || j.status === 'succeeded' || j.status === 'completed' ? 'green' : 'blue'}
        indeterminate={active && !j.total}
      />
      <div className="counters">
        <span><strong>{nf(progress)}</strong> / {j.total ? nf(j.total) : '?'} traités</span>
        <span className="c-green"><strong>{nf(j.deleted)}</strong> supprimés</span>
        <span className="c-blue"><strong>{nf(j.edited)}</strong> édités</span>
        <span className="c-red"><strong>{nf(j.failed)}</strong> échecs</span>
        <span><strong>{rate.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}</strong> msg/s mesurés</span>
      </div>
      {(j.error || err) && <Notice tone="error">{j.error || err}</Notice>}
      {logs.length > 0 && (
        <ul className="logs" aria-label="Journal du job">
          {logs.map((l) => (
            <li key={l.id || `${l.at}-${l.message}`} className={l.level === 'error' ? 'c-red' : l.level === 'warn' ? 'c-orange' : ''}>
              <span className="muted">{fmtDate(l.at)}</span> {l.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PURGE_SPEEDS = [
  { value: 'safe', label: 'Safe (le plus discret)' },
  { value: 'fast', label: 'Fast (risque de 429 plus élevé)' },
];

// Purges planifiées : traitement par lots, sans aucun maximum (SPEC-V4 A3 / B2).
function PurgesCard({ channelId, guildId, guildName, channelName, targetLabel }) {
  const purges = useLoad(
    async () => {
      try {
        return await api.discordPurges();
      } catch (e) {
        if (api.isMissingEndpoint(e)) return { unavailable: true };
        throw e;
      }
    },
    { poll: true }
  );
  const [intervalMin, setIntervalMin] = useState('60');
  const [chunkSize, setChunkSize] = useState('5000');
  const [pSpeed, setPSpeed] = useState('safe');
  const [pFrom, setPFrom] = useState('');
  const [pTo, setPTo] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const unavailable = !!purges.data?.unavailable;
  const list = Array.isArray(purges.data) ? purges.data : [];

  async function create(e) {
    e.preventDefault();
    setBusy('create');
    setErr('');
    try {
      await api.discordCreatePurge({
        channelId,
        ...(guildId ? { guildId, guildName } : {}),
        channelName,
        ...(pFrom ? { from: dayStartMs(pFrom) } : {}),
        ...(pTo ? { to: dayEndMs(pTo) } : {}),
        chunkSize: Math.max(1, Number(chunkSize) || 5000),
        intervalSec: Math.max(1, Number(intervalMin) || 60) * 60,
        speed: pSpeed,
      });
      await purges.reload(true);
    } catch (ex) {
      setErr(api.isMissingEndpoint(ex) ? 'Les purges planifiées ne sont pas disponibles sur ce serveur.' : ex.message);
    } finally {
      setBusy('');
    }
  }

  async function act(kind, id) {
    setBusy(`${kind}:${id}`);
    setErr('');
    try {
      if (kind === 'run') await api.discordRunPurge(id);
      else await api.discordCancelPurge(id);
      await purges.reload(true);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card
      title="5. Purges planifiées"
      subtitle="Aucun maximum — la purge continue par lots jusqu’à épuisement."
      actions={<button type="button" className="btn sm" onClick={() => purges.reload(true)}><Icon name="refresh" size={14} /> Actualiser</button>}
    >
      {purges.error && <Notice tone="error">{purges.error}</Notice>}
      {unavailable && <Notice tone="warn">Les purges planifiées ne sont pas disponibles sur ce serveur (endpoint absent).</Notice>}
      <form className="stack" onSubmit={create}>
        <p className="muted small">Cible : {targetLabel || 'choisissez un salon ou une conversation à l’étape 1'}.</p>
        <div className="grid-fields">
          <Field label="Intervalle (minutes)" hint="Délai entre deux exécutions.">
            <input type="number" min="1" value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
          </Field>
          <Field label="Taille de lot" hint="Messages traités par exécution (défaut 5000).">
            <input type="number" min="1" value={chunkSize} onChange={(e) => setChunkSize(e.target.value)} />
          </Field>
          <Select label="Vitesse" value={pSpeed} onChange={setPSpeed} options={PURGE_SPEEDS} />
          <Field label="Depuis le (optionnel)"><input type="date" value={pFrom} max={pTo || undefined} onChange={(e) => setPFrom(e.target.value)} /></Field>
          <Field label="Jusqu’au (optionnel)"><input type="date" value={pTo} min={pFrom || undefined} onChange={(e) => setPTo(e.target.value)} /></Field>
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!channelId || busy === 'create' || unavailable}>
            {busy === 'create' ? 'Création...' : 'Planifier la purge'}
          </button>
        </div>
      </form>
      {err && <Notice tone="error">{err}</Notice>}
      {list.length === 0 ? (
        !unavailable && <EmptyState icon="clock" title="Aucune purge planifiée">Les purges créées apparaîtront ici.</EmptyState>
      ) : (
        <ul className="list">
          {list.map((p) => {
            const live = p.status === 'active';
            return (
              <li key={p.id} className="stack">
                <div className="row wrap">
                  <strong>{p.guildName ? `${p.guildName} / ` : ''}#{p.channelName || p.channelId}</strong>
                  <StatusBadge value={p.status} />
                  <span className="grow" />
                  {live && (
                    <>
                      <button type="button" className="btn sm" disabled={!!busy} onClick={() => act('run', p.id)}>Exécuter maintenant</button>
                      <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => act('cancel', p.id)}>Annuler</button>
                    </>
                  )}
                </div>
                <div className="counters">
                  <span><strong>{nf(p.processed)}</strong> traités</span>
                  <span className="c-green"><strong>{nf(p.deleted)}</strong> supprimés</span>
                  <span className="c-red"><strong>{nf(p.failed)}</strong> échecs</span>
                  <span><strong>{nf(p.runs)}</strong> exécution(s)</span>
                </div>
                <div className="muted small">
                  Curseur : {p.cursorBefore || '-'} · Lot {nf(p.chunkSize)} · toutes les {nf(Math.round((p.intervalSec || 0) / 60))} min
                  {live ? ` · prochaine exécution : ${fmtDate(p.nextRunAt)}` : ''}
                </div>
                {p.error && <Notice tone="error">{p.error}</Notice>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DiscordManager() {
  const { discord } = useApp();
  const me = discord.user;
  const guilds = useLoad(() => api.discordGuilds());
  const dms = useLoad(() => api.discordDms());
  const recent = useLoad(() => api.discordJobs(), { poll: (d) => Array.isArray(d) && d.some((j) => isActive(j.status)) });

  // Cible
  const [source, setSource] = useState('guild');
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  // Filtres de recherche
  const [content, setContent] = useState('');
  const [authorMode, setAuthorMode] = useState('me');
  const [authorId, setAuthorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Résultats
  const [res, setRes] = useState(null);
  const [offset, setOffset] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [checked, setChecked] = useState(() => new Map());
  // Action
  const [scope, setScope] = useState('selection');
  const [maxMessages, setMaxMessages] = useState('');
  const [speed, setSpeed] = useState({ mode: 'adaptive', delayMs: 800, concurrency: 1 });
  const [editMode, setEditMode] = useState('replace');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(null); // 'delete' | 'edit'
  const [launching, setLaunching] = useState(false);
  const [actionErr, setActionErr] = useState('');
  const [jobIds, setJobIds] = useState([]);
  // Protections (portées hors sélection) : épinglés, pièces jointes, mots exclus.
  const [keepPinned, setKeepPinned] = useState(true);
  const [onlyAttachments, setOnlyAttachments] = useState(false);
  const [excludeWords, setExcludeWords] = useState('');
  // Aperçu avant suppression et délai de grâce avant lancement.
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null); // { kind, at }
  const [nowTick, setNowTick] = useState(Date.now());
  const lastIdx = useRef(-1);

  const guildList = Array.isArray(guilds.data) ? guilds.data : [];
  const dmList = Array.isArray(dms.data) ? dms.data : [];
  const guild = guildList.find((g) => g.id === guildId);
  const channels = (guild?.channels || []).filter((c) => ![2, 4, 13, 15].includes(c.type));
  const dm = dmList.find((d) => d.id === channelId);
  const dmName = (d) => d.name || d.recipients?.map((r) => r.username).join(', ') || d.id;

  // Filtres (insensibles à la casse et aux accents) ; la sélection courante reste toujours listée.
  const [guildQuery, setGuildQuery] = useState('');
  const [channelQuery, setChannelQuery] = useState('');
  const [dmQuery, setDmQuery] = useState('');
  const shownGuilds = guildList.filter((g) => g.id === guildId || matches(g.name, guildQuery));
  const shownChannels = channels.filter((c) => c.id === channelId || matches(c.name, channelQuery));
  const shownDms = dmList.filter((d) => d.id === channelId || matches(dmName(d), dmQuery));

  const targetLabel =
    source === 'dm'
      ? dm ? `MP · ${dm.name || dm.recipients?.map((r) => r.username).join(', ')}` : ''
      : guild ? `${guild.name}${channelId ? ` / #${channels.find((c) => c.id === channelId)?.name || channelId}` : ' / tous les salons'}` : '';

  const hasTarget = source === 'dm' ? !!channelId : !!guildId;
  const jobChannelOk = !!channelId;

  const msgs = res?.messages || [];
  const total = res?.total ?? msgs.length;
  const PAGE = 25;

  function resetResults() {
    setRes(null);
    setOffset(0);
    setChecked(new Map());
    setSearchErr('');
  }

  async function runSearch(nextOffset = 0) {
    lastIdx.current = -1;
    setSearching(true);
    setSearchErr('');
    try {
      const minId = from ? toSnowflake(dayStartMs(from)) : '';
      const maxId = to ? toSnowflake(dayEndMs(to)) : '';
      const data = await api.discordSearch({
        guildId: source === 'guild' ? guildId : '',
        channelId,
        authorId: authorMode === 'me' ? me?.id : authorMode === 'custom' ? authorId.trim() : '',
        content: content.trim(),
        minId,
        maxId,
        offset: nextOffset,
        limit: PAGE,
      });
      setRes(Array.isArray(data) ? { total: data.length, messages: data } : data);
      setOffset(nextOffset);
      if (nextOffset === 0) setChecked(new Map());
    } catch (e) {
      setSearchErr(e.message);
    } finally {
      setSearching(false);
    }
  }

  // Maj+clic : sélectionne (ou désélectionne) toute la plage depuis le dernier message cliqué.
  function toggleMsg(m, idx, shift) {
    const from = shift && lastIdx.current >= 0 ? Math.min(lastIdx.current, idx) : idx;
    const until = shift && lastIdx.current >= 0 ? Math.max(lastIdx.current, idx) : idx;
    setChecked((prev) => {
      const next = new Map(prev);
      const on = !next.has(m.id);
      msgs.slice(from, until + 1).forEach((x) => (on ? next.set(x.id, x) : next.delete(x.id)));
      return next;
    });
    lastIdx.current = idx;
  }
  function invertPage() {
    setChecked((prev) => {
      const next = new Map(prev);
      msgs.forEach((m) => (next.has(m.id) ? next.delete(m.id) : next.set(m.id, m)));
      return next;
    });
  }
  const allOnPage = msgs.length > 0 && msgs.every((m) => checked.has(m.id));
  function togglePage() {
    setChecked((prev) => {
      const next = new Map(prev);
      msgs.forEach((m) => (allOnPage ? next.delete(m.id) : next.set(m.id, m)));
      return next;
    });
  }

  const rangeValid = scope !== 'range' || from || to;
  const limitValue = scope === 'range' && Number(maxMessages) > 0 ? Number(maxMessages) : null;
  const scopeCount = scope === 'selection' ? checked.size : limitValue ?? (scope === 'all' && res?.total ? res.total : null);
  const sp = speedParams(speed);
  const eta = scopeCount && sp.delayMs ? (scopeCount * sp.delayMs) / 1000 : null;

  const editValid =
    editMode === 'replace' ? find.length > 0 : editMode === 'set' || editMode === 'append' || editMode === 'prepend' ? text.length > 0 : false;

  const readyBase = scope === 'selection' ? checked.size > 0
    : scope === 'search' ? hasTarget && !!(content.trim() || from || to)
      : jobChannelOk && rangeValid;

  function scopeDescription() {
    if (scope === 'selection') return `${nf(checked.size)} message(s) sélectionné(s) dans les résultats de recherche`;
    const lim = limitValue ? ` (maximum ${nf(limitValue)})` : ' (aucun maximum)';
    if (scope === 'all') return 'Conversation entière : tous vos messages du salon, sans aucun maximum';
    if (scope === 'search') return `Tous vos messages correspondant à la recherche${content.trim() ? ` « ${content.trim()} »` : ''}${from ? ` depuis le ${from}` : ''}${to ? ` jusqu’au ${to}` : ''}`;
    return `Vos messages du salon ${from ? `depuis le ${from}` : ''}${from && to ? ' ' : ''}${to ? `jusqu’au ${to}` : ''}${lim}`;
  }

  function buildBodies(kind) {
    const base = { speed: speedBody(speed) };
    if (kind === 'edit') {
      base.edit = editMode === 'replace' ? { mode: 'replace', find, replace } : { mode: editMode, text };
    }
    const lim = limitValue ? { maxMessages: limitValue } : {};
    if (scope === 'selection') {
      const groups = new Map();
      checked.forEach((m) => {
        const cid = m.channelId || channelId;
        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid).push(m.id);
      });
      return [...groups.entries()].map(([cid, ids]) => ({
        ...base,
        channelId: cid,
        ...(source === 'guild' && guildId ? { guildId } : {}),
        messageIds: ids,
      }));
    }
    const protect = { keepPinned, onlyAttachments, excludeWords: excludeWords.split(',').map((w) => w.trim()).filter(Boolean) };
    if (scope === 'search') {
      return [{
        ...base, ...protect, method: 'search', content: content.trim() || undefined,
        ...(channelId ? { channelId } : {}), ...(source === 'guild' && guildId ? { guildId } : {}),
        ...(from ? { after: toSnowflake(dayStartMs(from)) } : {}), ...(to ? { before: toSnowflake(dayEndMs(to)) } : {}),
      }];
    }
    const range = {};
    if (scope === 'range') {
      if (from) range.after = toSnowflake(dayStartMs(from));
      if (to) range.before = toSnowflake(dayEndMs(to));
    }
    return [{ ...base, ...protect, channelId, ...(source === 'guild' && guildId ? { guildId } : {}), ...range, ...lim }];
  }

  // Aperçu : estimation Discord + exemples, sans aucune action, à l'ouverture de la confirmation.
  useEffect(() => {
    if (!confirm || scope === 'selection') { setPreview(null); return undefined; }
    let alive = true;
    setPreview({ loading: true });
    api.discordPreviewJob(buildBodies(confirm)[0])
      .then((r) => { if (alive) setPreview(r); })
      .catch((e) => { if (alive) setPreview({ error: e.message }); });
    return () => { alive = false; };
  }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Délai de grâce : le job ne part qu'après GRACE_MS ; « Annuler » l'abandonne sans aucun appel Discord.
  const GRACE_MS = 5000;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => {
      setNowTick(Date.now());
      if (Date.now() >= pending.at) { clearInterval(t); const p = pending; setPending(null); launch(p); }
    }, 200);
    return () => clearInterval(t);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  // Les paramètres (cible, portée, filtres) sont figés à la confirmation : changer de salon pendant le délai
  // n'a aucun effet sur l'opération confirmée.
  function schedule() {
    setPending({ kind: confirm, at: Date.now() + GRACE_MS, bodies: buildBodies(confirm), clearSelection: scope === 'selection' });
    setNowTick(Date.now());
    setConfirm(null);
  }

  async function launch({ kind, bodies, clearSelection }) {
    setLaunching(true);
    setActionErr('');
    try {
      const ids = [];
      for (const body of bodies) {
        const r = kind === 'edit' ? await api.discordEditJob(body) : await api.discordDeleteJob(body);
        if (r?.jobId) ids.push(r.jobId);
      }
      setJobIds((prev) => [...ids, ...prev.filter((x) => !ids.includes(x))]);
      setConfirm(null);
      recent.reload(true);
      if (clearSelection) setChecked(new Map());
    } catch (e) {
      setConfirm(null);
      setActionErr(e.message);
    } finally {
      setLaunching(false);
    }
  }

  const recentJobs = Array.isArray(recent.data) ? recent.data : [];
  const sourceOptions = useMemo(() => [
    { value: 'guild', label: 'Serveur' },
    { value: 'dm', label: 'Messages privés' },
  ], []);

  return (
    <>
      <Card title="1. Choisir la cible" subtitle="Serveur puis salon, ou conversation privée.">
        {(guilds.error || dms.error) && <Notice tone="error">{guilds.error || dms.error}</Notice>}
        <div className="grid-fields">
          <Select
            label="Type"
            value={source}
            options={sourceOptions}
            onChange={(v) => { setSource(v); setGuildId(''); setChannelId(''); setGuildQuery(''); setChannelQuery(''); setDmQuery(''); resetResults(); }}
          />
          {source === 'guild' ? (
            <>
              <Field label="Filtrer les serveurs" hint={`${nf(shownGuilds.length)} / ${nf(guildList.length)} serveur(s)`}>
                <input type="search" value={guildQuery} onChange={(e) => setGuildQuery(e.target.value)} placeholder="Nom du serveur..." />
              </Field>
              <Select
                label="Serveur"
                value={guildId}
                disabled={guilds.loading}
                options={[{ value: '', label: guilds.loading ? 'Chargement...' : 'Choisir un serveur' }, ...shownGuilds.map((g) => ({ value: g.id, label: g.name }))]}
                onChange={(v) => { setGuildId(v); setChannelId(''); setChannelQuery(''); resetResults(); }}
              />
              <Field label="Filtrer les salons" hint={guildId ? `${nf(shownChannels.length)} / ${nf(channels.length)} salon(s)` : 'Choisissez un serveur d’abord'}>
                <input type="search" value={channelQuery} disabled={!guildId} onChange={(e) => setChannelQuery(e.target.value)} placeholder="Nom du salon..." />
              </Field>
              <Select
                label="Salon"
                value={channelId}
                disabled={!guildId}
                options={[{ value: '', label: guildId ? 'Tous les salons (recherche seule)' : 'Choisir un serveur d’abord' }, ...shownChannels.map((c) => ({ value: c.id, label: `# ${c.name}` }))]}
                onChange={(v) => { setChannelId(v); resetResults(); }}
              />
            </>
          ) : (
            <>
            <Field label="Rechercher un MP" hint={`${nf(shownDms.length)} / ${nf(dmList.length)} conversation(s)`}>
              <input type="search" value={dmQuery} onChange={(e) => setDmQuery(e.target.value)} placeholder="Nom ou pseudo..." />
            </Field>
            <Select
              label="Conversation"
              value={channelId}
              disabled={dms.loading}
              options={[{ value: '', label: dms.loading ? 'Chargement...' : 'Choisir une conversation' }, ...shownDms.map((d) => ({ value: d.id, label: dmName(d) }))]}
              onChange={(v) => { setChannelId(v); resetResults(); }}
            />
            </>
          )}
        </div>
        {!guilds.loading && source === 'guild' && guildList.length === 0 && !guilds.error && (
          <p className="muted small">Aucun serveur trouvé sur ce compte.</p>
        )}
      </Card>

      <Card className="message-search" title="2. Rechercher des messages" subtitle="Filtrez par auteur, date ou contenu.">
        <form
          className="stack"
          onSubmit={(e) => { e.preventDefault(); runSearch(0); }}
        >
          <div className="grid-fields">
            <Field label="Contenu contient">
              <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="mot, phrase..." />
            </Field>
            <Select
              label="Auteur"
              value={authorMode}
              onChange={setAuthorMode}
              options={[
                { value: 'me', label: 'Moi uniquement' },
                { value: 'any', label: 'Tous les auteurs' },
                { value: 'custom', label: 'ID d’un auteur' },
              ]}
            />
            {authorMode === 'custom' && (
              <Field label="ID de l’auteur">
                <input value={authorId} onChange={(e) => setAuthorId(e.target.value)} inputMode="numeric" placeholder="123456789012345678" />
              </Field>
            )}
            <Field label="Depuis le">
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Jusqu’au">
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={!hasTarget || searching}>
              <Icon name="search" size={16} /> {searching ? 'Recherche...' : 'Rechercher'}
            </button>
            {res && <button type="button" className="btn" onClick={resetResults}>Effacer</button>}
          </div>
        </form>

        {searchErr && <Notice tone="error">{searchErr}</Notice>}
        {!res && !searching && !searchErr && (
          <EmptyState icon="search" title="Aucune recherche lancée">
            Choisissez une cible puis lancez une recherche pour sélectionner des messages précis.
          </EmptyState>
        )}
        {res && msgs.length === 0 && (
          <EmptyState icon="chat" title="Aucun message trouvé">Modifiez les filtres puis relancez la recherche.</EmptyState>
        )}
        {msgs.length > 0 && (
          <>
            <div className="row table-bar">
              <button type="button" className="btn sm" onClick={togglePage}>
                {allOnPage ? 'Désélectionner la page' : 'Sélectionner la page'}
              </button>
              <button type="button" className="btn sm" onClick={invertPage}>Inverser la page</button>
              <button type="button" className="btn sm" disabled={checked.size === 0} onClick={() => setChecked(new Map())}>
                Tout désélectionner
              </button>
              <span className="grow" />
              <span className="muted small" role="status" aria-live="polite">
                {nf(total)} résultat(s) · <strong>{nf(checked.size)}</strong> sélectionné(s)
              </span>
            </div>
            <p className="muted small">Cliquez sur un message pour l’ajouter ou le retirer de la sélection. Maj+clic sélectionne toute la plage depuis le dernier message cliqué.</p>
            <ul className="msg-list">
              {msgs.map((m, idx) => (
                <li key={m.id} className={checked.has(m.id) ? 'sel' : ''} onClick={(e) => toggleMsg(m, idx, e.shiftKey)}>
                  <div className="check">
                    <input type="checkbox" className="deco" checked={checked.has(m.id)} readOnly tabIndex={-1} aria-hidden="true" />
                    <span className="msg">
                      <span className="msg-meta">
                        <strong>{msgAuthor(m)}</strong>
                        {m.channelName && <span className="muted"> · #{m.channelName}</span>}
                        <span className="muted"> · {fmtDate(msgDate(m))}</span>
                        {Array.isArray(m.attachments) && m.attachments.length > 0 && <span className="muted"> · {m.attachments.length} pièce(s) jointe(s)</span>}
                        {m.pinned && <span className="muted"> · épinglé</span>}
                      </span>
                      <span className="msg-text">{msgText(m) || <em className="muted">(sans texte)</em>}</span>
                      {checked.has(m.id) && <span className="sr-only">Message sélectionné</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="row pager">
              <button type="button" className="btn sm" disabled={offset === 0 || searching} onClick={() => runSearch(Math.max(0, offset - PAGE))}>Précédent</button>
              <span className="muted small">
                {nf(offset + 1)} - {nf(offset + msgs.length)} sur {nf(total)}
              </span>
              <button type="button" className="btn sm" disabled={offset + PAGE >= total || searching} onClick={() => runSearch(offset + PAGE)}>Suivant</button>
            </div>
          </>
        )}
      </Card>

      <Card title="3. Action groupée" subtitle="Les messages sont copiés dans l’archive locale avant toute modification.">
        <fieldset className="fieldset">
          <legend className="field-label">Messages concernés</legend>
          <div className="segmented" role="radiogroup" aria-label="Messages concernés">
            {[
              ['selection', 'Sélection souris'],
              ['range', 'Plage de dates'],
              ['search', 'Tous les résultats de la recherche'],
              ['all', 'Conversation entière (aucun maximum)'],
            ].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? 'on' : ''} onClick={() => setScope(v)}>
                {l}
              </button>
            ))}
          </div>
          {scope === 'selection' && (
            <p className="muted small" role="status" aria-live="polite">
              <strong>{nf(checked.size)}</strong> message(s) sélectionné(s) à la souris dans les résultats de recherche.
              {checked.size > 0 && <> <button type="button" className="link" onClick={() => setChecked(new Map())}>Tout désélectionner</button></>}
            </p>
          )}
          {scope === 'range' && (
            <p className="muted small">Les dates « depuis » et « jusqu’au » du bloc de recherche servent de plage{from || to ? ` (${from || '...'} → ${to || '...'})` : ' : renseignez-en au moins une'}.</p>
          )}
          {scope === 'all' && (
            <p className="muted small">
              Tous vos messages du salon ou de la conversation choisi(e) sont traités, par lots, sans aucun maximum
              {res?.total ? ` (environ ${nf(res.total)} correspondance(s) dans la dernière recherche)` : ''}.
            </p>
          )}
          {scope === 'search' && (
            <p className="muted small">Toutes les pages de la recherche (contenu et dates du bloc 2), uniquement vos messages{channelId ? '' : ', dans tout le serveur ou la conversation'}{content.trim() || from || to ? '' : ' : renseignez un contenu ou une date'}.</p>
          )}
          {scope !== 'selection' && scope !== 'search' && !jobChannelOk && <Notice tone="warn">Choisissez un salon précis (pas « tous les salons ») pour ce mode.</Notice>}
          {scope === 'range' && (
            <div className="grid-fields">
              <Field label="Limite maximale (optionnel)" hint={limitValue ? `Maximum ${nf(limitValue)} messages.` : 'Laisser vide = aucun maximum.'}>
                <input type="number" min="1" value={maxMessages} onChange={(e) => setMaxMessages(e.target.value)} placeholder="Aucun maximum" />
              </Field>
            </div>
          )}
        </fieldset>

        {scope !== 'selection' && (
          <fieldset className="fieldset">
            <legend className="field-label">Protections</legend>
            <label className="check"><input type="checkbox" checked={keepPinned} onChange={(e) => setKeepPinned(e.target.checked)} /><span>Conserver les messages épinglés</span></label>
            <label className="check"><input type="checkbox" checked={onlyAttachments} onChange={(e) => setOnlyAttachments(e.target.checked)} /><span>Seulement les messages avec pièce jointe</span></label>
            <Field label="Ne jamais toucher aux messages contenant" hint="Mots ou expressions séparés par des virgules (50 maximum).">
              <input value={excludeWords} onChange={(e) => setExcludeWords(e.target.value)} placeholder="anniversaire, adresse, ..." />
            </Field>
          </fieldset>
        )}

        <SpeedPicker speed={speed} setSpeed={setSpeed} />
        {eta && <p className="muted small">Durée estimée : environ {fmtDuration(eta)} (hors limitations Discord).</p>}

        <fieldset className="fieldset">
          <legend className="field-label">Édition en masse</legend>
          <div className="grid-fields">
            <Select label="Mode d’édition" value={editMode} onChange={setEditMode} options={EDIT_MODES} />
            {editMode === 'replace' ? (
              <>
                <Field label="Texte à chercher"><input value={find} onChange={(e) => setFind(e.target.value)} /></Field>
                <Field label="Remplacer par"><input value={replace} onChange={(e) => setReplace(e.target.value)} /></Field>
              </>
            ) : (
              <Field label="Texte"><input value={text} onChange={(e) => setText(e.target.value)} /></Field>
            )}
          </div>
          <p className="muted small">Seuls vos propres messages peuvent être édités.</p>
        </fieldset>

        {actionErr && <Notice tone="error">{actionErr}</Notice>}
        {pending && (
          <div className="notice warn row wrap" role="status" aria-live="polite">
            <span className="grow">{pending.kind === 'edit' ? 'Édition' : 'Suppression'} lancée dans {Math.max(0, Math.ceil((pending.at - nowTick) / 1000))} s. Aucune requête n’a encore été envoyée.</span>
            <button type="button" className="btn sm" onClick={() => setPending(null)}>Annuler</button>
            <button type="button" className="btn sm danger-solid" onClick={() => { const p = pending; setPending(null); launch(p); }}>Lancer maintenant</button>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn danger-solid" disabled={!readyBase || !!pending} onClick={() => setConfirm('delete')}>
            <Icon name="trash" size={16} /> Supprimer en masse
          </button>
          <button type="button" className="btn" disabled={!readyBase || !editValid || !!pending} onClick={() => setConfirm('edit')}>
            <Icon name="edit" size={16} /> Éditer en masse
          </button>
        </div>
      </Card>

      <Card id="discord-jobs" title="4. Suivi des opérations" actions={<button type="button" className="btn sm" onClick={() => recent.reload(true)}><Icon name="refresh" size={14} /> Actualiser</button>}>
        {jobIds.length === 0 && recentJobs.length === 0 ? (
          <EmptyState icon="clock" title="Aucun job">Les suppressions et éditions lancées apparaîtront ici avec leur progression.</EmptyState>
        ) : (
          <div className="stack">
            {jobIds.map((id) => <JobPanel key={id} id={id} onCancelled={() => recent.reload(true)} />)}
            {recentJobs.filter((j) => !jobIds.includes(j.id)).length > 0 && (
              <>
                <h3 className="sub-title">Jobs récents</h3>
                <ul className="list">
                  {recentJobs.filter((j) => !jobIds.includes(j.id)).slice(0, 8).map((j) => (
                    <li key={j.id} className="row wrap">
                      <span>{j.kind === 'edit' ? 'Édition' : 'Suppression'} · {fmtDate(j.createdAt)}</span>
                      <StatusBadge value={j.status} />
                      <span className="muted small grow">{nf(j.deleted)} suppr. · {nf(j.edited)} édités · {nf(j.failed)} échecs</span>
                      <button type="button" className="btn sm" onClick={() => setJobIds((p) => [j.id, ...p])}>Suivre</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </Card>

      <PurgesCard
        channelId={channelId}
        guildId={source === 'guild' ? guildId : ''}
        guildName={guild?.name}
        channelName={source === 'dm' ? (dm?.name || dm?.recipients?.map((r) => r.username).join(', ')) : channels.find((c) => c.id === channelId)?.name}
        targetLabel={channelId ? targetLabel : ''}
      />

      <Confirm
        open={confirm === 'delete'}
        title="Confirmer la suppression en masse"
        confirmLabel="Supprimer définitivement"
        danger
        requireText="SUPPRIMER"
        busy={launching}
        onCancel={() => setConfirm(null)}
        onConfirm={schedule}
      >
        <ul className="summary">
          <li><strong>Cible :</strong> {targetLabel || 'salon sélectionné'}</li>
          <li><strong>Portée :</strong> {scopeDescription()}</li>
          <li><strong>Vitesse :</strong> {SPEEDS[speed.mode].label} ({sp.delayMs} ms, concurrence {sp.concurrency})</li>
          {scope !== 'selection' && (keepPinned || onlyAttachments || excludeWords.trim()) && (
            <li><strong>Protections :</strong> {[keepPinned && 'épinglés conservés', onlyAttachments && 'pièces jointes seulement', excludeWords.trim() && `mots exclus : ${excludeWords.trim()}`].filter(Boolean).join(' · ')}</li>
          )}
        </ul>
        <PreviewBox preview={preview} />
        <Notice tone="warn">Les messages supprimés sur Discord ne peuvent pas être restaurés. Une copie est conservée dans l’archive locale.</Notice>
      </Confirm>
      <Confirm
        open={confirm === 'edit'}
        title="Confirmer l’édition en masse"
        confirmLabel="Éditer les messages"
        danger
        requireText="MODIFIER"
        busy={launching}
        onCancel={() => setConfirm(null)}
        onConfirm={schedule}
      >
        <ul className="summary">
          <li><strong>Cible :</strong> {targetLabel || 'salon sélectionné'}</li>
          <li><strong>Portée :</strong> {scopeDescription()}</li>
          <li>
            <strong>Modification :</strong>{' '}
            {editMode === 'replace' ? `remplacer « ${find} » par « ${replace} »` : `${EDIT_MODES.find((m) => m.value === editMode)?.label.toLowerCase()} : « ${text} »`}
          </li>
          <li><strong>Vitesse :</strong> {SPEEDS[speed.mode].label} ({sp.delayMs} ms, concurrence {sp.concurrency})</li>
        </ul>
        <Notice tone="warn">Le contenu original est sauvegardé dans l’archive locale, mais l’édition sur Discord est définitive.</Notice>
      </Confirm>
    </>
  );
}

function PreviewBox({ preview }) {
  if (!preview) return null;
  if (preview.loading) return <p className="muted small">Aperçu en cours (une recherche Discord, aucune suppression)…</p>;
  if (preview.error) return <Notice tone="warn">Aperçu indisponible : {preview.error}</Notice>;
  return (
    <div className="preview-box">
      <p><strong>Aperçu :</strong> environ {nf(preview.total)} message(s) à vous{preview.filtered ? ' avant application des protections' : ''}.</p>
      {preview.sample?.length > 0 && (
        <ul className="preview-list">
          {preview.sample.map((m) => (
            <li key={m.id}><span className="muted small">{fmtDate(msgDate(m))}</span> {msgText(m) || '(sans texte)'}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RateStatus() {
  const { data: r } = useLoad(() => api.get('/discord/rate-limits'), { poll: true });
  if (!r) return null;
  return <div className="rate-status" role="status">
    <span className={`dot ${r.globalWaitMs ? 'down' : 'up'}`} />
    <strong>{r.globalWaitMs ? `Pause Discord · ${Math.ceil(r.globalWaitMs / 1000)} s` : 'Régulation adaptative active'}</strong>
    <span className="grow muted small">{r.queued} requête(s) en attente · {r.waitingBuckets} quota(s) en temporisation</span>
    <span className="muted small" title="Plafond conservateur de l’application, les quotas Discord restent prioritaires">Plafond app : {r.cap} req/s</span>
  </div>;
}

export default function Discord() {
  return (
    <>
      <PageHeader title="Votre historique, sous contrôle" subtitle="Discord · Recherchez, archivez et nettoyez vos propres messages." />
      <DiscordGate>
        <RateStatus /><DiscordManager />
      </DiscordGate>
    </>
  );
}
