import React, { useState } from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice } from '../components/Card.jsx';
import Select from '../components/Select.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Badge from '../components/Badge.jsx';
import { fmtDate } from '../lib.js';

const FREQ = [
  { value: 'hour', label: 'Toutes les heures', cron: '0 * * * *' },
  { value: 'day', label: 'Tous les jours', cron: '0 0 * * *' },
  { value: 'week', label: 'Toutes les semaines', cron: '0 0 * * 1' },
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
    if (s.kind === 'discord') return 'Discord · archive des messages';
    const src = s.kind === 'axe' ? axes : claws;
    return src.find((x) => x.id === s.targetId)?.name || s.targetId;
  };
  const kindLabel = (k) => (k === 'axe' ? 'Archive' : k === 'discord' ? 'Scan Discord' : 'Scan broker');

  async function submit(e) {
    e.preventDefault();
    setError('');
    let body;
    const cron = FREQ.find((f) => f.value === freq).cron;
    if (kind === 'discord') {
      // Réutilise l'axe Discord du catalogue s'il existe, sinon tente un type dédié.
      body = discordAxe ? { kind: 'axe', targetId: discordAxe.id, cron } : { kind: 'discord', targetId: 'messages', cron };
    } else {
      const target = targetId || options[0]?.id;
      if (!target) {
        setError('Aucune cible disponible.');
        return;
      }
      body = { kind, targetId: target, cron };
    }
    setBusy(true);
    try {
      await api.createSchedule(body);
      await schedules.reload(true);
    } catch (err) {
      setError(kind === 'discord' && err.status === 400 ? 'Le serveur ne gère pas encore les planifications Discord.' : err.message);
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
      <PageHeader title="Schedule" subtitle="Automatisez vos scans et vos archives." />
      <Notice tone="error">{error || schedules.error}</Notice>
      <div className="cols">
        <Card title={`Planifications (${list.length})`}>
          {list.length === 0 ? (
            <EmptyState icon="clock" title="Aucune planification">Créez-en une avec le formulaire.</EmptyState>
          ) : (
            <ul className="list">
              {list.map((s) => (
                <li className="row wrap" key={s.id}>
                  <div className="grow">
                    <strong>{nameOf(s)}</strong> <Badge>{kindLabel(s.kind)}</Badge>
                    <div className="muted small">
                      {cronLabel(s.cron)} · dernière : {fmtDate(s.lastRunAt)} · prochaine : {fmtDate(s.nextRunAt)}
                    </div>
                  </div>
                  <button type="button" className="btn sm danger" onClick={() => remove(s.id)}>Supprimer</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Nouvelle planification">
          <form className="stack" onSubmit={submit}>
            <Select
              label="Type"
              value={kind}
              onChange={(v) => { setKind(v); setTargetId(''); }}
              options={[
                { value: 'scan', label: 'Scan data broker' },
                { value: 'axe', label: 'Archive réseau social' },
                { value: 'discord', label: 'Scan Discord', disabled: discord.state !== 'connected' },
              ]}
              hint={discord.state !== 'connected' ? 'Le scan Discord nécessite un compte connecté.' : undefined}
            />
            {kind !== 'discord' && (
              <Select
                label="Cible"
                value={targetId || options[0]?.id || ''}
                onChange={setTargetId}
                options={options.length ? options.map((o) => ({ value: o.id, label: o.name })) : [{ value: '', label: 'Aucune cible' }]}
              />
            )}
            <Select label="Fréquence" value={freq} onChange={setFreq} options={FREQ} />
            <p className="muted small">Expression : <span className="mono">{FREQ.find((f) => f.value === freq).cron}</span></p>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}>Planifier</button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
