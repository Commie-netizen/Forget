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
  { value: 'all', label: 'Toute la période', ms: 0 },
  { value: 'day', label: '24 dernières heures', ms: DAY },
  { value: 'week', label: '7 derniers jours', ms: 7 * DAY },
  { value: 'month', label: '30 derniers jours', ms: 30 * DAY },
  { value: 'year', label: '12 derniers mois', ms: 365 * DAY },
];
const ACTION_LABEL = { delete: 'Suppression', edit: 'Édition', disappeared: 'Disparu', vanish: 'Disparu', disappearing: 'Disparu' };
const actionLabel = (a) => ACTION_LABEL[a] || a || 'Archivé';
const actionTone = (a) => (a === 'delete' ? 'red' : a === 'edit' ? 'blue' : 'orange');

function countBy(list, key) {
  const m = new Map();
  list.forEach((x) => {
    const k = key(x);
    m.set(k, (m.get(k) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function StatList({ title, rows, empty = 'Aucune donnée' }) {
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
      return ms ? new Date(ms).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : 'Date inconnue';
    }),
  }), [items]);

  return (
    <>
      <PageHeader
        title="Local Archive"
        subtitle="Une copie locale de chaque message avant sa suppression ou son édition."
        actions={
          <>
            <Select label="Format d’export" hideLabel value={format} onChange={setFormat} options={[{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }]} />
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
              Conservez sur cet ordinateur le contenu de vos messages avant toute action. Les données restent dans la base SQLite locale et ne sont jamais envoyées ailleurs.
            </p>
          </div>
          <Badge tone={localArchive ? 'green' : 'neutral'}>{localArchive ? 'ON' : 'OFF'}</Badge>
          <Toggle checked={localArchive} onChange={setLocalArchive} label="Activer Local Archive" />
        </div>
      </Card>

      {unavailable && <Notice tone="warn" title="Module Discord indisponible">L’archive Discord ne peut pas être lue pour le moment.</Notice>}
      {list.error && !unavailable && discord.state !== 'disconnected' && <Notice tone="error">{list.error}</Notice>}

      <Card title="Search Your Archive">
        <form className="search-panel" onSubmit={(e) => e.preventDefault()} role="search">
          <label className="search-input">
            <span className="sr-only">Rechercher dans l’archive</span>
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un message, un salon..." />
          </label>
          <Select label="Plateforme" hideLabel value={platform} onChange={setPlatform} options={[{ value: 'all', label: 'Toutes les plateformes' }, { value: 'discord', label: 'Discord' }, { value:'twitter',label:'Twitter/X' }, {value:'reddit',label:'Reddit'}]} />
          <Select label="Période" hideLabel value={period} onChange={setPeriod} options={PERIODS} />
          <Select label="Tri" hideLabel value={sort} onChange={setSort} options={[{ value: 'recent', label: 'Plus récents' }, { value: 'old', label: 'Plus anciens' }]} />
        </form>

        {list.loading && !list.data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState icon="archive" title="No archives yet">
            Les messages supprimés ou édités apparaîtront ici. Aucune archive ne correspond à ces filtres.
          </EmptyState>
        ) : (
          <ul className="archive-list">
            {items.slice(0, 100).map((a) => (
              <li key={a.id}>
                <div className="row wrap">
                  <Badge tone="red">{(a.platform || 'discord').replace(/^./, (c) => c.toUpperCase())}</Badge>
                  <span className="muted small">{[a.guildName, a.channelName && `#${a.channelName}`].filter(Boolean).join(' / ') || 'Salon inconnu'}</span>
                  <span className="grow" />
                  <Badge tone={actionTone(a.action)}>{actionLabel(a.action)}</Badge>
                  <span className="muted small">{fmtDate(a.archivedAt)}</span>
                </div>
                <p className="archive-text">{a.content || <em className="muted">(sans texte)</em>}</p>
              </li>
            ))}
            {items.length > 100 && <li className="muted small">{nf(items.length - 100)} autres résultats : affinez la recherche ou exportez l’archive.</li>}
          </ul>
        )}
      </Card>

      <div className="cols">
        <Card title="Recent Activity">
          {items.length === 0 ? (
            <p className="muted small">Aucune activité récente.</p>
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
        <Card title="Archive Statistics" subtitle={`${nf(items.length)} élément(s) correspondant aux filtres`}>
          <div className="stat-cols">
            <StatList title="Par plateforme" rows={stats.platform} />
            <StatList title="Par action" rows={stats.action} />
            <StatList title="Par période" rows={stats.month.slice(0, 6)} />
          </div>
        </Card>
      </div>
    </>
  );
}
