import React, { useMemo, useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Spinner } from '../components/Card.jsx';
import Toggle from '../components/Toggle.jsx';
import Select from '../components/Select.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Badge from '../components/Badge.jsx';
import Icon from '../components/Icon.jsx';
import { fmtDate, nf, toMs } from '../lib.js';

const DAY = 86400000;
const PERIODS = [
  { value: 'all', label: "All time", ms: 0 },
  { value: 'day', label: "Last 24 hours", ms: DAY },
  { value: 'week', label: "Last 7 days", ms: 7 * DAY },
  { value: 'month', label: "Last 30 days", ms: 30 * DAY },
  { value: 'year', label: "Last 12 months", ms: 365 * DAY },
];
const ACTION_LABEL = { delete: "Deletion", edit: "Editing", disappeared: "Disappeared", vanish: "Disappeared", disappearing: "Disappeared" };
const actionLabel = (a) => ACTION_LABEL[a] || a || "Archived";
const actionTone = (a) => (a === 'delete' ? 'red' : a === 'edit' ? 'blue' : 'orange');

function countBy(list, key) {
  const m = new Map();
  list.forEach((x) => {
    const k = key(x);
    m.set(k, (m.get(k) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function StatList({ title, rows, empty = "No data" }) {
  return (
    <div>
      <h3 className="sub-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="list tight">
          {rows.map(([k, v]) => (
            <li key={k} className="row"><span>{k}</span><strong>{nf(v)}</strong></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function LocalArchive() {
  const { localArchive, setLocalArchive, discord } = useApp();
  const connected = discord.state === 'connected';
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState('all');
  const [period, setPeriod] = useState('all');
  const [sort, setSort] = useState('recent');
  const [format, setFormat] = useState('json');

  const per = PERIODS.find((p) => p.value === period);
  const from = per.ms ? Date.now() - per.ms : '';
  const list = useLoad(
    () => api.discordArchive({ q: q.trim(), platform: platform === 'all' ? '' : platform, from, limit: 500 }),
    { enabled: connected || discord.state === 'disconnected', deps: [q, platform, period] }
  );
  const items = useMemo(() => {
    const arr = Array.isArray(list.data) ? [...list.data] : [];
    arr.sort((a, b) => {
      const d = (toMs(b.archivedAt) || 0) - (toMs(a.archivedAt) || 0);
      return sort === 'recent' ? d : -d;
    });
    return arr;
  }, [list.data, sort]);

  const unavailable = discord.state === 'unavailable';
  const stats = useMemo(() => ({
    platform: countBy(items, (x) => x.platform || 'discord'),
    action: countBy(items, (x) => actionLabel(x.action)),
    month: countBy(items, (x) => {
      const ms = toMs(x.archivedAt);
      return ms ? new Date(ms).toLocaleDateString("en-US", { month: 'long', year: 'numeric' }) : "Unknown date";
    }),
  }), [items]);

  return (
    <>
      <PageHeader
        title="Local Archive"
        subtitle="A local copy of each message before deletion or editing."
        actions={
          <>
            <Select label="Export format" hideLabel value={format} onChange={setFormat} options={[{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }]} />
            <a
              className={`btn primary${unavailable ? ' disabled' : ''}`}
              href={unavailable ? undefined : api.discordArchiveExportUrl(format)}
              aria-disabled={unavailable}
              download
            >
              <Icon name="download" size={16} /> Export Archive
            </a>
          </>
        }
      />

      <Card className="archive-toggle">
        <div className="row">
          <div className="grow">
            <h2 className="card-title">Local Archive</h2>
            <p className="muted small">
              Save your message content on this computer before any action. Data stays in the local SQLite database and is never sent elsewhere.
            </p>
          </div>
          <Badge tone={localArchive ? 'green' : 'neutral'}>{localArchive ? 'ON' : 'OFF'}</Badge>
          <Toggle checked={localArchive} onChange={setLocalArchive} label="Enable Local Archive" />
        </div>
      </Card>

      {unavailable && <Notice tone="warn" title="Discord module unavailable">The Discord archive cannot be read right now.</Notice>}
      {list.error && !unavailable && discord.state !== 'disconnected' && <Notice tone="error">{list.error}</Notice>}

      <Card title="Search Your Archive">
        <form className="search-panel" onSubmit={(e) => e.preventDefault()} role="search">
          <label className="search-input">
            <span className="sr-only">Search the archive</span>
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a message, channel..." />
          </label>
          <Select label="Platform" hideLabel value={platform} onChange={setPlatform} options={[{ value: 'all', label: "All platforms" }, { value: 'discord', label: 'Discord' }, { value:'twitter',label:'Twitter/X' }, {value:'reddit',label:'Reddit'}]} />
          <Select label="Period" hideLabel value={period} onChange={setPeriod} options={PERIODS} />
          <Select label="Sort" hideLabel value={sort} onChange={setSort} options={[{ value: 'recent', label: "Newest first" }, { value: 'old', label: "Oldest first" }]} />
        </form>

        {list.loading && !list.data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState icon="archive" title="No archives yet">
            Deleted or edited messages will appear here. No archives match these filters.
          </EmptyState>
        ) : (
          <ul className="archive-list">
            {items.slice(0, 100).map((a) => (
              <li key={a.id}>
                <div className="row wrap">
                  <Badge tone="red">{(a.platform || 'discord').replace(/^./, (c) => c.toUpperCase())}</Badge>
                  <span className="muted small">{[a.guildName, a.channelName && `#${a.channelName}`].filter(Boolean).join(' / ') || "Unknown channel"}</span>
                  <span className="grow" />
                  <Badge tone={actionTone(a.action)}>{actionLabel(a.action)}</Badge>
                  <span className="muted small">{fmtDate(a.archivedAt)}</span>
                </div>
                <p className="archive-text">{a.content || <em className="muted">(no text)</em>}</p>
              </li>
            ))}
            {items.length > 100 && <li className="muted small">{nf(items.length - 100)} more results: refine your search or export the archive.</li>}
          </ul>
        )}
      </Card>

      <div className="cols">
        <Card title="Recent Activity">
          {items.length === 0 ? (
            <p className="muted small">No recent activity.</p>
          ) : (
            <ul className="list tight">
              {items.slice(0, 6).map((a) => (
                <li key={a.id} className="row">
                  <span className="ellipsis">{actionLabel(a.action)} · {(a.content || '').slice(0, 48) || 'message'}</span>
                  <span className="muted small nowrap">{fmtDate(a.archivedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Archive Statistics" subtitle={`${nf(items.length)} items matching the filters`}>
          <div className="stat-cols">
            <StatList title="By platform" rows={stats.platform} />
            <StatList title="By action" rows={stats.action} />
            <StatList title="By period" rows={stats.month.slice(0, 6)} />
          </div>
        </Card>
      </div>
    </>
  );
}
