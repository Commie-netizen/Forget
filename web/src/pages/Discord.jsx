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
  adaptive: { label: "Adaptive", desc: "Pace adjusts to Discord rate limits, shared across all operations.", delayMs: 0, concurrency: 4 },
  safe: { label: "Cautious", desc: "At least 900 ms between operations, respecting Discord rate limits.", delayMs: 900, concurrency: 1 },
  fast: { label: "Fast", desc: "At least 300 ms between operations, respecting Discord rate limits.", delayMs: 300, concurrency: 2 },
  custom: { label: "Custom", desc: "Set the delay and concurrency yourself." },
};

const EDIT_MODES = [
  { value: 'replace', label: "Replace text" },
  { value: 'set', label: "Replace all content" },
  { value: 'append', label: "Append text" },
  { value: 'prepend', label: "Prepend text" },
];

function SpeedPicker({ speed, setSpeed }) {
  const preset = SPEEDS[speed.mode];
  return (
    <fieldset className="fieldset">
      <legend className="field-label">Speed</legend>
      <div className="segmented" role="radiogroup" aria-label="Execution speed">
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
          <Slider label="Delay between requests" unit=" ms" min={150} max={2000} step={50} value={speed.delayMs} onChange={(v) => setSpeed({ ...speed, delayMs: v })} />
          <Slider label="Concurrency" min={1} max={4} step={1} value={speed.concurrency} onChange={(v) => setSpeed({ ...speed, concurrency: v })} />
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

  if (!j) return job.error ? <Notice tone="error">{job.error}</Notice> : <p className="muted small">Loading job...</p>;
  const active = isActive(j.status);
  const done = (j.deleted || 0) + (j.edited || 0) + (j.failed || 0);
  const progress = j.progress ?? done;
  const logs = Array.isArray(j.logs) ? j.logs.slice(-8) : [];
  const elapsed = j.startedAt ? Math.max(1, ((j.finishedAt || Date.now()) - j.startedAt) / 1000) : 0;
  const rate = elapsed ? ((j.deleted || 0) + (j.edited || 0)) / elapsed : 0;
  return (
    <div className="job">
      <div className="row">
        <strong>{j.kind === 'edit' ? "Bulk edit" : "Bulk deletion"}</strong>
        {j.params?.channelId && <span className="muted small">{j.params.channelName || j.params.channelId}</span>}
        <StatusBadge value={j.status} />
        <span className="grow" />
        {active && (
          <button type="button" className="btn sm danger" disabled={busy || j.cancelRequested} onClick={cancel}>
            {j.cancelRequested ? "Cancellation requested..." : "Cancel"}
          </button>
        )}
      </div>
      <Progress
        label="Job progress"
        value={progress}
        max={j.total || Math.max(progress, 1)}
        tone={j.status === 'failed' ? 'red' : j.status === 'done' || j.status === 'succeeded' || j.status === 'completed' ? 'green' : 'blue'}
        indeterminate={active && !j.total}
      />
      <div className="counters">
        <span><strong>{nf(progress)}</strong> / {j.total ? nf(j.total) : '?'} processed</span>
        <span className="c-green"><strong>{nf(j.deleted)}</strong> deleted</span>
        <span className="c-blue"><strong>{nf(j.edited)}</strong> edited</span>
        <span className="c-red"><strong>{nf(j.failed)}</strong> failures</span>
        <span><strong>{rate.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong> msg/s measured</span>
      </div>
      {(j.error || err) && <Notice tone="error">{j.error || err}</Notice>}
      {logs.length > 0 && (
        <ul className="logs" aria-label="Job log">
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
  { value: 'safe', label: "Safe (most discreet)" },
  { value: 'fast', label: "Fast (higher risk of 429 errors)" },
];

// Scheduled purges: batch processing with no limit (SPEC-V4 A3 / B2).
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
      setErr(api.isMissingEndpoint(ex) ? "Scheduled purges are unavailable on this server." : ex.message);
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
      title="5. Scheduled purges"
      subtitle="No limit. The purge runs in batches until complete."
      actions={<button type="button" className="btn sm" onClick={() => purges.reload(true)}><Icon name="refresh" size={14} /> Refresh</button>}
    >
      {purges.error && <Notice tone="error">{purges.error}</Notice>}
      {unavailable && <Notice tone="warn">Scheduled purges are unavailable on this server (missing endpoint).</Notice>}
      <form className="stack" onSubmit={create}>
        <p className="muted small">Target: {targetLabel || "choose a channel or conversation in step 1"}.</p>
        <div className="grid-fields">
          <Field label="Interval (minutes)" hint="Delay between runs.">
            <input type="number" min="1" value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
          </Field>
          <Field label="Batch size" hint="Messages processed per run (default 5000).">
            <input type="number" min="1" value={chunkSize} onChange={(e) => setChunkSize(e.target.value)} />
          </Field>
          <Select label="Speed" value={pSpeed} onChange={setPSpeed} options={PURGE_SPEEDS} />
          <Field label="From (optional)"><input type="date" value={pFrom} max={pTo || undefined} onChange={(e) => setPFrom(e.target.value)} /></Field>
          <Field label="Until (optional)"><input type="date" value={pTo} min={pFrom || undefined} onChange={(e) => setPTo(e.target.value)} /></Field>
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!channelId || busy === 'create' || unavailable}>
            {busy === 'create' ? "Creating..." : "Schedule purge"}
          </button>
        </div>
      </form>
      {err && <Notice tone="error">{err}</Notice>}
      {list.length === 0 ? (
        !unavailable && <EmptyState icon="clock" title="No scheduled purges">Your purges will appear here.</EmptyState>
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
                      <button type="button" className="btn sm" disabled={!!busy} onClick={() => act('run', p.id)}>Run now</button>
                      <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => act('cancel', p.id)}>Cancel</button>
                    </>
                  )}
                </div>
                <div className="counters">
                  <span><strong>{nf(p.processed)}</strong> processed</span>
                  <span className="c-green"><strong>{nf(p.deleted)}</strong> deleted</span>
                  <span className="c-red"><strong>{nf(p.failed)}</strong> failures</span>
                  <span><strong>{nf(p.runs)}</strong> runs</span>
                </div>
                <div className="muted small">
                  Cursor: {p.cursorBefore || '-'} · Batch {nf(p.chunkSize)} · every {nf(Math.round((p.intervalSec || 0) / 60))} min
                  {live ? ` · next run: ${fmtDate(p.nextRunAt)}` : ''}
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

  // Target
  const [source, setSource] = useState('guild');
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  // Search filters
  const [content, setContent] = useState('');
  const [authorMode, setAuthorMode] = useState('me');
  const [authorId, setAuthorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Results
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
  // Safeguards (outside selection scope): pinned messages, attachments, excluded words.
  const [keepPinned, setKeepPinned] = useState(true);
  const [onlyAttachments, setOnlyAttachments] = useState(false);
  const [excludeWords, setExcludeWords] = useState('');
  // Preview before deletion and grace period before starting.
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

  // Case- and accent-insensitive filters; keep the current selection listed.
  const [guildQuery, setGuildQuery] = useState('');
  const [channelQuery, setChannelQuery] = useState('');
  const [dmQuery, setDmQuery] = useState('');
  const shownGuilds = guildList.filter((g) => g.id === guildId || matches(g.name, guildQuery));
  const shownChannels = channels.filter((c) => c.id === channelId || matches(c.name, channelQuery));
  const shownDms = dmList.filter((d) => d.id === channelId || matches(dmName(d), dmQuery));

  const targetLabel =
    source === 'dm'
      ? dm ? `DM · ${dm.name || dm.recipients?.map((r) => r.username).join(', ')}` : ''
      : guild ? `${guild.name}${channelId ? ` / #${channels.find((c) => c.id === channelId)?.name || channelId}` : " / all channels"}` : '';

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

  // Shift+click selects (or deselects) the range from the last clicked message.
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
    if (scope === 'selection') return `${nf(checked.size)} messages selected in search results`;
    const lim = limitValue ? ` (maximum ${nf(limitValue)})` : " (no limit)";
    if (scope === 'all') return "Entire conversation: all your messages in the channel, with no limit";
    if (scope === 'search') return `All your messages matching the search${content.trim() ? ` "${content.trim()}"` : ''}${from ? ` from ${from}` : ''}${to ? ` until ${to}` : ''}`;
    return `Your messages in channel ${from ? `from ${from}` : ''}${from && to ? ' ' : ''}${to ? `until ${to}` : ''}${lim}`;
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

  // Preview: Discord estimate and examples, with no action, when confirmation opens.
  useEffect(() => {
    if (!confirm || scope === 'selection') { setPreview(null); return undefined; }
    let alive = true;
    setPreview({ loading: true });
    api.discordPreviewJob(buildBodies(confirm)[0])
      .then((r) => { if (alive) setPreview(r); })
      .catch((e) => { if (alive) setPreview({ error: e.message }); });
    return () => { alive = false; };
  }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grace period: the job starts only after GRACE_MS; Cancel discards it without any Discord call.
  const GRACE_MS = 5000;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => {
      setNowTick(Date.now());
      if (Date.now() >= pending.at) { clearInterval(t); const p = pending; setPending(null); launch(p); }
    }, 200);
    return () => clearInterval(t);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  // Parameters (target, scope, filters) are frozen at confirmation: changing channels during the delay
  // has no effect on the confirmed operation.
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
    { value: 'guild', label: "Server" },
    { value: 'dm', label: "Direct messages" },
  ], []);

  return (
    <>
      <Card title="1. Choose a target" subtitle="Server and channel, or a direct conversation.">
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
              <Field label="Filter servers" hint={`${nf(shownGuilds.length)} / ${nf(guildList.length)} servers`}>
                <input type="search" value={guildQuery} onChange={(e) => setGuildQuery(e.target.value)} placeholder="Server name..." />
              </Field>
              <Select
                label="Server"
                value={guildId}
                disabled={guilds.loading}
                options={[{ value: '', label: guilds.loading ? "Loading..." : "Choose a server" }, ...shownGuilds.map((g) => ({ value: g.id, label: g.name }))]}
                onChange={(v) => { setGuildId(v); setChannelId(''); setChannelQuery(''); resetResults(); }}
              />
              <Field label="Filter channels" hint={guildId ? `${nf(shownChannels.length)} / ${nf(channels.length)} channels` : "Choose a server first"}>
                <input type="search" value={channelQuery} disabled={!guildId} onChange={(e) => setChannelQuery(e.target.value)} placeholder="Channel name..." />
              </Field>
              <Select
                label="Channel"
                value={channelId}
                disabled={!guildId}
                options={[{ value: '', label: guildId ? "All channels (search only)" : "Choose a server first" }, ...shownChannels.map((c) => ({ value: c.id, label: `# ${c.name}` }))]}
                onChange={(v) => { setChannelId(v); resetResults(); }}
              />
            </>
          ) : (
            <>
            <Field label="Search DMs" hint={`${nf(shownDms.length)} / ${nf(dmList.length)} conversations`}>
              <input type="search" value={dmQuery} onChange={(e) => setDmQuery(e.target.value)} placeholder="Name or username..." />
            </Field>
            <Select
              label="Conversation"
              value={channelId}
              disabled={dms.loading}
              options={[{ value: '', label: dms.loading ? "Loading..." : "Choose a conversation" }, ...shownDms.map((d) => ({ value: d.id, label: dmName(d) }))]}
              onChange={(v) => { setChannelId(v); resetResults(); }}
            />
            </>
          )}
        </div>
        {!guilds.loading && source === 'guild' && guildList.length === 0 && !guilds.error && (
          <p className="muted small">No servers found for this account.</p>
        )}
      </Card>

      <Card className="message-search" title="2. Search messages" subtitle="Filter by author, date, or content.">
        <form
          className="stack"
          onSubmit={(e) => { e.preventDefault(); runSearch(0); }}
        >
          <div className="grid-fields">
            <Field label="Content contains">
              <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="word, phrase..." />
            </Field>
            <Select
              label="Author"
              value={authorMode}
              onChange={setAuthorMode}
              options={[
                { value: 'me', label: "Only me" },
                { value: 'any', label: "All authors" },
                { value: 'custom', label: "Author ID" },
              ]}
            />
            {authorMode === 'custom' && (
              <Field label="Author ID">
                <input value={authorId} onChange={(e) => setAuthorId(e.target.value)} inputMode="numeric" placeholder="123456789012345678" />
              </Field>
            )}
            <Field label="From">
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Until">
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={!hasTarget || searching}>
              <Icon name="search" size={16} /> {searching ? "Searching..." : "Search"}
            </button>
            {res && <button type="button" className="btn" onClick={resetResults}>Clear</button>}
          </div>
        </form>

        {searchErr && <Notice tone="error">{searchErr}</Notice>}
        {!res && !searching && !searchErr && (
          <EmptyState icon="search" title="No search started">
            Choose a target and search to select specific messages.
          </EmptyState>
        )}
        {res && msgs.length === 0 && (
          <EmptyState icon="chat" title="No messages found">Change the filters and search again.</EmptyState>
        )}
        {msgs.length > 0 && (
          <>
            <div className="row table-bar">
              <button type="button" className="btn sm" onClick={togglePage}>
                {allOnPage ? "Deselect page" : "Select page"}
              </button>
              <button type="button" className="btn sm" onClick={invertPage}>Invert page selection</button>
              <button type="button" className="btn sm" disabled={checked.size === 0} onClick={() => setChecked(new Map())}>
                Deselect all
              </button>
              <span className="grow" />
              <span className="muted small" role="status" aria-live="polite">
                {nf(total)} results · <strong>{nf(checked.size)}</strong> selected
              </span>
            </div>
            <p className="muted small">Click a message to select or deselect it. Shift+click selects the range from the last clicked message.</p>
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
                        {Array.isArray(m.attachments) && m.attachments.length > 0 && <span className="muted"> · {m.attachments.length} attachments</span>}
                        {m.pinned && <span className="muted"> · pinned</span>}
                      </span>
                      <span className="msg-text">{msgText(m) || <em className="muted">(no text)</em>}</span>
                      {checked.has(m.id) && <span className="sr-only">Selected message</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="row pager">
              <button type="button" className="btn sm" disabled={offset === 0 || searching} onClick={() => runSearch(Math.max(0, offset - PAGE))}>Previous</button>
              <span className="muted small">
                {nf(offset + 1)} - {nf(offset + msgs.length)} of {nf(total)}
              </span>
              <button type="button" className="btn sm" disabled={offset + PAGE >= total || searching} onClick={() => runSearch(offset + PAGE)}>Next</button>
            </div>
          </>
        )}
      </Card>

      <Card title="3. Bulk action" subtitle="Messages are copied to the local archive before any changes.">
        <fieldset className="fieldset">
          <legend className="field-label">Messages to include</legend>
          <div className="segmented" role="radiogroup" aria-label="Messages to include">
            {[
              ['selection', "Mouse selection"],
              ['range', "Date range"],
              ['search', "All search results"],
              ['all', "Entire conversation (no limit)"],
            ].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? 'on' : ''} onClick={() => setScope(v)}>
                {l}
              </button>
            ))}
          </div>
          {scope === 'selection' && (
            <p className="muted small" role="status" aria-live="polite">
              <strong>{nf(checked.size)}</strong> messages selected by mouse in search results.
              {checked.size > 0 && <> <button type="button" className="link" onClick={() => setChecked(new Map())}>Deselect all</button></>}
            </p>
          )}
          {scope === 'range' && (
            <p className="muted small">The From and Until dates in the search section define the range{from || to ? ` (${from || '...'} → ${to || '...'})` : ": enter at least one date"}.</p>
          )}
          {scope === 'all' && (
            <p className="muted small">
              All your messages in the selected channel or conversation are processed in batches, with no limit
              {res?.total ? ` (about ${nf(res.total)} matches in the last search)` : ''}.
            </p>
          )}
          {scope === 'search' && (
            <p className="muted small">All search pages (content and dates from section 2), only your messages{channelId ? '' : ", across the server or conversation"}{content.trim() || from || to ? '' : ": enter content or a date"}.</p>
          )}
          {scope !== 'selection' && scope !== 'search' && !jobChannelOk && <Notice tone="warn">Choose a specific channel (not "all channels") for this mode.</Notice>}
          {scope === 'range' && (
            <div className="grid-fields">
              <Field label="Maximum limit (optional)" hint={limitValue ? `Maximum ${nf(limitValue)} messages.` : "Leave blank for no limit."}>
                <input type="number" min="1" value={maxMessages} onChange={(e) => setMaxMessages(e.target.value)} placeholder="No limit" />
              </Field>
            </div>
          )}
        </fieldset>

        {scope !== 'selection' && (
          <fieldset className="fieldset">
            <legend className="field-label">Safeguards</legend>
            <label className="check"><input type="checkbox" checked={keepPinned} onChange={(e) => setKeepPinned(e.target.checked)} /><span>Keep pinned messages</span></label>
            <label className="check"><input type="checkbox" checked={onlyAttachments} onChange={(e) => setOnlyAttachments(e.target.checked)} /><span>Only messages with attachments</span></label>
            <Field label="Never change messages containing" hint="Comma-separated words or phrases (up to 50).">
              <input value={excludeWords} onChange={(e) => setExcludeWords(e.target.value)} placeholder="birthday, address, ..." />
            </Field>
          </fieldset>
        )}

        <SpeedPicker speed={speed} setSpeed={setSpeed} />
        {eta && <p className="muted small">Estimated duration: about {fmtDuration(eta)} (excluding Discord rate limits).</p>}

        <fieldset className="fieldset">
          <legend className="field-label">Bulk edit</legend>
          <div className="grid-fields">
            <Select label="Edit mode" value={editMode} onChange={setEditMode} options={EDIT_MODES} />
            {editMode === 'replace' ? (
              <>
                <Field label="Text to find"><input value={find} onChange={(e) => setFind(e.target.value)} /></Field>
                <Field label="Replace with"><input value={replace} onChange={(e) => setReplace(e.target.value)} /></Field>
              </>
            ) : (
              <Field label="Text"><input value={text} onChange={(e) => setText(e.target.value)} /></Field>
            )}
          </div>
          <p className="muted small">Only your own messages can be edited.</p>
        </fieldset>

        {actionErr && <Notice tone="error">{actionErr}</Notice>}
        {pending && (
          <div className="notice warn row wrap" role="status" aria-live="polite">
            <span className="grow">{pending.kind === 'edit' ? "Editing" : "Deletion"} starts in {Math.max(0, Math.ceil((pending.at - nowTick) / 1000))} s. No requests have been sent yet.</span>
            <button type="button" className="btn sm" onClick={() => setPending(null)}>Cancel</button>
            <button type="button" className="btn sm danger-solid" onClick={() => { const p = pending; setPending(null); launch(p); }}>Start now</button>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn danger-solid" disabled={!readyBase || !!pending} onClick={() => setConfirm('delete')}>
            <Icon name="trash" size={16} /> Bulk delete
          </button>
          <button type="button" className="btn" disabled={!readyBase || !editValid || !!pending} onClick={() => setConfirm('edit')}>
            <Icon name="edit" size={16} /> Bulk edit
          </button>
        </div>
      </Card>

      <Card id="discord-jobs" title="4. Operation progress" actions={<button type="button" className="btn sm" onClick={() => recent.reload(true)}><Icon name="refresh" size={14} /> Refresh</button>}>
        {jobIds.length === 0 && recentJobs.length === 0 ? (
          <EmptyState icon="clock" title="No jobs">Deletion and editing jobs will appear here with their progress.</EmptyState>
        ) : (
          <div className="stack">
            {jobIds.map((id) => <JobPanel key={id} id={id} onCancelled={() => recent.reload(true)} />)}
            {recentJobs.filter((j) => !jobIds.includes(j.id)).length > 0 && (
              <>
                <h3 className="sub-title">Recent jobs</h3>
                <ul className="list">
                  {recentJobs.filter((j) => !jobIds.includes(j.id)).slice(0, 8).map((j) => (
                    <li key={j.id} className="row wrap">
                      <span>{j.kind === 'edit' ? "Editing" : "Deletion"} · {fmtDate(j.createdAt)}</span>
                      <StatusBadge value={j.status} />
                      <span className="muted small grow">{nf(j.deleted)} deleted · {nf(j.edited)} edited · {nf(j.failed)} failures</span>
                      <button type="button" className="btn sm" onClick={() => setJobIds((p) => [j.id, ...p])}>Track</button>
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
        title="Confirm bulk deletion"
        confirmLabel="Delete permanently"
        danger
        requireText="DELETE"
        busy={launching}
        onCancel={() => setConfirm(null)}
        onConfirm={schedule}
      >
        <ul className="summary">
          <li><strong>Target:</strong> {targetLabel || "selected channel"}</li>
          <li><strong>Scope:</strong> {scopeDescription()}</li>
          <li><strong>Speed:</strong> {SPEEDS[speed.mode].label} ({sp.delayMs} ms, concurrency {sp.concurrency})</li>
          {scope !== 'selection' && (keepPinned || onlyAttachments || excludeWords.trim()) && (
            <li><strong>Safeguards:</strong> {[keepPinned && "pinned messages kept", onlyAttachments && "attachments only", excludeWords.trim() && `excluded words: ${excludeWords.trim()}`].filter(Boolean).join(' · ')}</li>
          )}
        </ul>
        <PreviewBox preview={preview} />
        <Notice tone="warn">Messages deleted from Discord cannot be restored. A copy is kept in the local archive.</Notice>
      </Confirm>
      <Confirm
        open={confirm === 'edit'}
        title="Confirm bulk edit"
        confirmLabel="Edit messages"
        danger
        requireText="EDIT"
        busy={launching}
        onCancel={() => setConfirm(null)}
        onConfirm={schedule}
      >
        <ul className="summary">
          <li><strong>Target:</strong> {targetLabel || "selected channel"}</li>
          <li><strong>Scope:</strong> {scopeDescription()}</li>
          <li>
            <strong>Change:</strong>{' '}
            {editMode === 'replace' ? `replace "${find}" with "${replace}"` : `${EDIT_MODES.find((m) => m.value === editMode)?.label.toLowerCase()}: "${text}"`}
          </li>
          <li><strong>Speed:</strong> {SPEEDS[speed.mode].label} ({sp.delayMs} ms, concurrency {sp.concurrency})</li>
        </ul>
        <Notice tone="warn">The original content is saved in the local archive, but edits on Discord are permanent.</Notice>
      </Confirm>
    </>
  );
}

function PreviewBox({ preview }) {
  if (!preview) return null;
  if (preview.loading) return <p className="muted small">Loading preview (one Discord search, no deletion)…</p>;
  if (preview.error) return <Notice tone="warn">Preview unavailable: {preview.error}</Notice>;
  return (
    <div className="preview-box">
      <p><strong>Preview:</strong> about {nf(preview.total)} of your messages{preview.filtered ? " before safeguards" : ''}.</p>
      {preview.sample?.length > 0 && (
        <ul className="preview-list">
          {preview.sample.map((m) => (
            <li key={m.id}><span className="muted small">{fmtDate(msgDate(m))}</span> {msgText(m) || "(no text)"}</li>
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
    <strong>{r.globalWaitMs ? `Discord pause · ${Math.ceil(r.globalWaitMs / 1000)} s` : "Adaptive rate limiting active"}</strong>
    <span className="grow muted small">{r.queued} pending requests · {r.waitingBuckets} rate limits on cooldown</span>
    <span className="muted small" title="Conservative app limit; Discord rate limits take priority">App limit: {r.cap} req/s</span>
  </div>;
}

export default function Discord() {
  return (
    <>
      <PageHeader title="Your history, under your control" subtitle="Discord · Search, archive, and clean up your own messages." />
      <DiscordGate>
        <RateStatus /><DiscordManager />
      </DiscordGate>
    </>
  );
}
