import React from 'react';
import * as api from '../api.js';
import { useApp, useLoad } from '../hooks.js';
import { Card, PageHeader, Notice, Stat } from '../components/Card.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { fmtDate, nf, isActive } from '../lib.js';

// Glyphes SVG inline (24x24) pour la rangée de tuiles « courtiers ».
const TILE_PATHS = [
  <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></>,
  <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></>,
  <><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></>,
  <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  <><path d="M12 21s6-5.2 6-10a6 6 0 0 0-12 0c0 4.8 6 10 6 10Z" /><circle cx="12" cy="11" r="2" /></>,
  <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17" /></>,
  <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
];
const TILE_LABELS = ['Identité', 'E-mail', 'Téléphone', 'Adresse', 'Finances', 'Localisation', 'Web', 'Protection'];

function MassDeleteBlock({ onLaunch }) {
  return (
    <section className="promo" aria-labelledby="promo-mass">
      <div className="promo-text">
        <span className="promo-kicker">SUPPRESSION DE MASSE</span>
        <h2 id="promo-mass">Supprime ton empreinte numérique</h2>
        <p className="muted">Retrouve tes messages Discord, sélectionne-les à la souris ou purge des salons entiers, en arrière-plan.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onLaunch}>Lancer une suppression</button>
        </div>
      </div>
      <div className="promo-visual msg-stack" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`msg-card c${i}`}>
            <span className="msg-av" />
            <span className="msg-lines"><i /><i /></span>
            <span className="msg-x">×</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BrokersBlock({ onLaunch }) {
  return (
    <section className="promo" aria-labelledby="promo-brokers">
      <div className="promo-text">
        <span className="promo-kicker">DATA BROKERS</span>
        <h2 id="promo-brokers">Supprime-toi automatiquement de 100+ courtiers</h2>
        <p className="muted">Scanne les courtiers de données et demande le retrait de tes informations personnelles.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onLaunch}>Lancer les suppressions</button>
        </div>
      </div>
      <div className="promo-visual tile-row" aria-hidden="true">
        {TILE_PATHS.map((path, i) => (
          <span key={TILE_LABELS[i]} className="tile" title={TILE_LABELS[i]}>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
          </span>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const { profiles, navigate, discord } = useApp();
  const connected = discord.state === 'connected';

  const brokers = useLoad(async () => {
    const [scans, events] = await Promise.all([api.listScanJobs(), api.listEvents(8)]);
    return { scans, events };
  }, { poll: (d) => !!d && d.scans.some((j) => isActive(j.status)) });

  const dj = useLoad(() => api.discordJobs(), { enabled: connected, deps: [connected], poll: (d) => Array.isArray(d) && d.some((j) => isActive(j.status)) });
  const arch = useLoad(() => api.discordArchive({ limit: 500 }), { enabled: connected, deps: [connected] });

  const jobs = Array.isArray(dj.data) ? dj.data : [];
  const archived = Array.isArray(arch.data) ? arch.data.length : 0;
  const removed = jobs.reduce((n, j) => n + (j.deleted || 0), 0);
  const scans = brokers.data?.scans || [];
  const events = brokers.data?.events || [];

  return (
    <>
      <PageHeader title="Home" subtitle="Résumé de votre protection de la vie privée." />
      {brokers.error && <Notice tone="error">{brokers.error}</Notice>}
      {discord.state === 'unavailable' && (
        <Notice tone="warn" title="Module Discord indisponible">Les statistiques Discord s’afficheront quand il sera actif.</Notice>
      )}

      <MassDeleteBlock onLaunch={() => navigate(connected ? 'discord' : 'overview')} />
      <BrokersBlock onLaunch={() => navigate('brokers')} />

      <section className="grid stats" aria-label="Statistiques">
        <Stat label="Messages archivés" value={connected ? nf(archived) : '-'} />
        <Stat label="Suppressions Discord" value={connected ? nf(removed) : '-'} />
        <Stat label="Profils" value={nf(profiles.length)} />
        <Stat label="Brokers scannés" value={nf(scans.length)} />
      </section>

      <div className="cols">
        <Card title="Activité récente">
          {events.length === 0 && jobs.length === 0 ? (
            <EmptyState icon="clock" title="Aucune activité">Les scans, suppressions et archives apparaîtront ici.</EmptyState>
          ) : (
            <ul className="list">
              {jobs.slice(0, 4).map((j) => (
                <li key={j.id} className="row">
                  <span>Discord · {j.kind === 'edit' ? 'édition' : 'suppression'} · {nf(j.deleted || j.edited)} traités</span>
                  <span className="muted small">{fmtDate(j.createdAt)}</span>
                </li>
              ))}
              {events.map((e) => (
                <li key={e.id} className="row">
                  <span className="mono">{e.type}</span>
                  <span className="muted small">{fmtDate(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Raccourcis">
          <div className="stack">
            <button type="button" className="btn primary" onClick={() => navigate(connected ? 'discord' : 'overview')}>
              {connected ? 'Nettoyer mes messages Discord' : 'Connecter Discord'}
            </button>
            <button type="button" className="btn" onClick={() => navigate('disappearing')}>Activer le mode disparition</button>
            <button type="button" className="btn" onClick={() => navigate('archive')}>Parcourir l’archive locale</button>
            <button type="button" className="btn" onClick={() => navigate('brokers')}>Scanner un data broker</button>
            <button type="button" className="btn" onClick={() => navigate('profiles')}>Gérer les profils</button>
          </div>
        </Card>
      </div>
    </>
  );
}
