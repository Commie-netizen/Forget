import React, { useEffect, useState } from 'react';
import * as api from '../api.js';
import { useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Field } from '../components/Card.jsx';
import DiscordGate from '../components/DiscordGate.jsx';
import Toggle from '../components/Toggle.jsx';
import Select from '../components/Select.jsx';
import Badge from '../components/Badge.jsx';
import { fmtDuration } from '../lib.js';

const SCOPES = [
  { value: 'all', label: 'Tous mes messages (serveurs et MP)' },
  { value: 'guilds', label: 'Serveurs sélectionnés' },
  { value: 'dm', label: 'Messages privés uniquement' },
];

function splitDelay(sec) {
  const s = Number(sec) || 60;
  return s % 60 === 0 && s >= 60 ? { value: s / 60, unit: 'min' } : { value: s, unit: 's' };
}

function DisappearingPanel() {
  const state = useLoad(() => api.discordDisappearing(), { poll: true });
  const guilds = useLoad(() => api.discordGuilds());
  const [enabled, setEnabled] = useState(false);
  const [delay, setDelay] = useState(60);
  const [unit, setUnit] = useState('s');
  const [scope, setScope] = useState('all');
  const [guildIds, setGuildIds] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const d = state.data;
  // Synchronise le formulaire avec le serveur tant que l'utilisateur n'a rien modifié.
  useEffect(() => {
    if (!d) return;
    setEnabled(!!d.enabled);
    if (!dirty) {
      const sp = splitDelay(d.delaySec);
      setDelay(sp.value);
      setUnit(sp.unit);
      setScope(d.scope || 'all');
      setGuildIds(Array.isArray(d.guildIds) ? d.guildIds : []);
    }
  }, [d, dirty]);

  const delaySec = Math.max(1, Math.round(Number(delay) || 0)) * (unit === 'min' ? 60 : 1);
  const guildList = Array.isArray(guilds.data) ? guilds.data : [];

  async function save(patch) {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const next = await api.discordSetDisappearing(patch);
      state.setData(next);
      setDirty(false);
      setSaved(true);
      await state.reload(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (on) => save({ enabled: on, delaySec, scope, guildIds });
  const apply = () => save({ delaySec, scope, guildIds });
  const mark = (fn) => (v) => { fn(v); setDirty(true); setSaved(false); };

  const running = !!d?.running;
  return (
    <>
      {(state.error || error) && <Notice tone="error">{error || state.error}</Notice>}
      <Card
        title="Mode disparition"
        subtitle="Supprime automatiquement vos nouveaux messages après un délai."
        actions={<Toggle checked={enabled} onChange={toggle} disabled={busy || !d} label="Activer le mode disparition" />}
      >
        <div className="row">
          <span className="muted small">État du watcher :</span>
          {!d ? (
            <Badge>Chargement</Badge>
          ) : enabled && running ? (
            <Badge tone="green">Actif · gateway connecté</Badge>
          ) : enabled ? (
            <Badge tone="orange">Activé · connexion au gateway...</Badge>
          ) : (
            <Badge>Arrêté</Badge>
          )}
        </div>
        {enabled && <p className="muted small">Chaque nouveau message envoyé sera supprimé après {fmtDuration(d?.delaySec || delaySec)}.</p>}
      </Card>

      <Card title="Réglages">
        <div className="stack">
          <div className="grid-fields">
            <Field label="Délai avant suppression">
              <input type="number" min="1" value={delay} onChange={(e) => mark(setDelay)(e.target.value)} />
            </Field>
            <Select
              label="Unité"
              value={unit}
              onChange={mark(setUnit)}
              options={[{ value: 's', label: 'Secondes' }, { value: 'min', label: 'Minutes' }]}
            />
            <Select label="Portée" value={scope} onChange={mark(setScope)} options={SCOPES} />
          </div>
          {scope === 'guilds' && (
            <fieldset className="fieldset">
              <legend className="field-label">Serveurs concernés</legend>
              {guilds.loading ? (
                <p className="muted small">Chargement...</p>
              ) : guildList.length === 0 ? (
                <p className="muted small">{guilds.error || 'Aucun serveur disponible.'}</p>
              ) : (
                <div className="check-grid">
                  {guildList.map((g) => (
                    <label key={g.id} className="check">
                      <input
                        type="checkbox"
                        checked={guildIds.includes(g.id)}
                        onChange={(e) => mark(setGuildIds)(e.target.checked ? [...guildIds, g.id] : guildIds.filter((x) => x !== g.id))}
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {guildIds.length === 0 && <Notice tone="warn">Aucun serveur coché : rien ne sera supprimé.</Notice>}
            </fieldset>
          )}
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy || !dirty} onClick={apply}>Appliquer</button>
            {saved && <span className="c-green small" role="status">Réglages enregistrés.</span>}
          </div>
        </div>
      </Card>

      <Notice tone="warn" title="Fonctionne tant que l’application tourne">
        Le watcher écoute le gateway Discord depuis cette machine. Si l’application est fermée, les messages ne seront pas supprimés.
      </Notice>
    </>
  );
}

export default function Disappearing() {
  return (
    <>
      <PageHeader title="Disappearing Mode" subtitle="Vos messages s’effacent tout seuls." />
      <DiscordGate>
        <DisappearingPanel />
      </DiscordGate>
    </>
  );
}
