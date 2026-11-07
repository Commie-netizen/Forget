import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice } from '../components/Card.jsx';
import Select from '../components/Select.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Badge from '../components/Badge.jsx';
import { fmtDate } from '../lib.js';

const FREQ = [
  { value: 'hour', label: "Hourly", cron: '0 * * * *' },
  { value: 'day', label: "Daily", cron: '0 0 * * *' },
  { value: 'week', label: "Weekly", cron: '0 0 * * 1' },
];
const cronLabel = (c) => FREQ.find((f) => f.cron === c)?.label || c;

export default function Schedule() {
  const { discord } = useApp();
  const [kind, setKind] = useState('scan');
  const [targetId, setTargetId] = useState('');
  const [freq, setFreq] = useState('day');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const targets = useLoad(async () => {
    const [claws, axes] = await Promise.all([api.listClaws(), api.listAxes()]);
    return { claws, axes };
  });
  const schedules = useLoad(() => api.listSchedules());

  const claws = Array.isArray(targets.data?.claws) ? targets.data.claws : [];
  const axes = Array.isArray(targets.data?.axes) ? targets.data.axes : [];
  const discordAxe = axes.find((a) => /discord/i.test(a.name || a.id));
  const options = kind === 'scan' ? claws : kind === 'axe' ? axes : [];
  const list = Array.isArray(schedules.data) ? schedules.data : [];

  const nameOf = (s) => {
    if (s.kind === 'discord') return "Discord · message archive";
    const src = s.kind === 'axe' ? axes : claws;
    return src.find((x) => x.id === s.targetId)?.name || s.targetId;
  };
  const kindLabel = (k) => (k === 'axe' ? 'Archive' : k === 'discord' ? "Discord scan" : "Broker scan");

  async function submit(e) {
    e.preventDefault();
    setError('');
    let body;
    const cron = FREQ.find((f) => f.value === freq).cron;
    if (kind === 'discord') {
      // Reuse the Discord axe from the catalog if available; otherwise try a dedicated type.
      body = discordAxe ? { kind: 'axe', targetId: discordAxe.id, cron } : { kind: 'discord', targetId: 'messages', cron };
    } else {
      const target = targetId || options[0]?.id;
      if (!target) {
        setError("No targets available.");
        return;
      }
      body = { kind, targetId: target, cron };
    }
    setBusy(true);
    try {
      await api.createSchedule(body);
      await schedules.reload(true);
    } catch (err) {
      setError(kind === 'discord' && err.status === 400 ? "The server does not support Discord schedules yet." : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    try {
      await api.deleteSchedule(id);
      await schedules.reload(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <PageHeader title="Schedule" subtitle="Automate your scans and archives." />
      <Notice tone="error">{error || schedules.error}</Notice>
      <div className="cols">
        <Card title={`Schedules (${list.length})`}>
          {list.length === 0 ? (
            <EmptyState icon="clock" title="No schedules">Create one using the form.</EmptyState>
          ) : (
            <ul className="list">
              {list.map((s) => (
                <li className="row wrap" key={s.id}>
                  <div className="grow">
                    <strong>{nameOf(s)}</strong> <Badge>{kindLabel(s.kind)}</Badge>
                    <div className="muted small">
                      {cronLabel(s.cron)} · last: {fmtDate(s.lastRunAt)} · next: {fmtDate(s.nextRunAt)}
                    </div>
                  </div>
                  <button type="button" className="btn sm danger" onClick={() => remove(s.id)}>Delete</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="New schedule">
          <form className="stack" onSubmit={submit}>
            <Select
              label="Type"
              value={kind}
              onChange={(v) => { setKind(v); setTargetId(''); }}
              options={[
                { value: 'scan', label: "Data broker scan" },
                { value: 'axe', label: "Social media archive" },
                { value: 'discord', label: "Discord scan", disabled: discord.state !== 'connected' },
              ]}
              hint={discord.state !== 'connected' ? "Discord scanning requires a connected account." : undefined}
            />
            {kind !== 'discord' && (
              <Select
                label="Target"
                value={targetId || options[0]?.id || ''}
                onChange={setTargetId}
                options={options.length ? options.map((o) => ({ value: o.id, label: o.name })) : [{ value: '', label: "No target" }]}
              />
            )}
            <Select label="Frequency" value={freq} onChange={setFreq} options={FREQ} />
            <p className="muted small">Expression: <span className="mono">{FREQ.find((f) => f.value === freq).cron}</span></p>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}>Schedule</button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
