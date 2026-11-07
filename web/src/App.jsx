import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api.js';
import { AppContext, useLoad } from './hooks.js';
import Sidebar from './components/Sidebar.jsx';
import { Modal } from './components/Modal.jsx';
import Badge from './components/Badge.jsx';
import JobsBanner from './components/JobsBanner.jsx';
import Home from './pages/Home.jsx';
import Overview from './pages/Overview.jsx';
import Discord from './pages/Discord.jsx';
import Social from './pages/Social.jsx';
import TikTok from './pages/TikTok.jsx';
import ExportPurge from './pages/ExportPurge.jsx';
import Schedule from './pages/Schedule.jsx';
import Disappearing from './pages/Disappearing.jsx';
import LocalArchive from './pages/LocalArchive.jsx';
import DataBrokers from './pages/DataBrokers.jsx';
import Settings from './pages/Settings.jsx';
import Profiles from './pages/Profiles.jsx';

const PAGES = {
  home: Home,
  overview: Overview,
  discord: Discord,
  twitter: Social, reddit: Social, facebook: Social, instagram: Social, tiktok: TikTok,
  export: ExportPurge,
  schedule: Schedule,
  disappearing: Disappearing,
  archive: LocalArchive,
  brokers: DataBrokers,
  settings: Settings,
  profiles: Profiles,
};

const SOCIAL_PLATFORMS = [{id:'twitter',name:'Twitter/X'}, {id:'reddit',name:'Reddit'}, {id:'facebook',name:'Facebook'}, {id:'instagram',name:'Instagram'}];

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

export default function App() {
  const [page, setPage] = useState('home');
  const [theme, setThemeState] = useState(() => localStorage.getItem('forget.theme') || 'dark');
  const [activeId, setActiveIdState] = useState(() => localStorage.getItem('forget.activeProfile') || '');
  const [addOpen, setAddOpen] = useState(false);
  const [localArchive, setLocalArchiveState] = useState(() => localStorage.getItem('forget.localArchive') !== 'off');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }, [theme]);
  const setTheme = useCallback((t) => {
    localStorage.setItem('forget.theme', t);
    setThemeState(t);
  }, []);

  const setActiveId = useCallback((id) => {
    if (id) localStorage.setItem('forget.activeProfile', id);
    else localStorage.removeItem('forget.activeProfile');
    setActiveIdState(id || '');
  }, []);

  const social = useLoad(() => api.get('/social'), { poll: true });
  const health = useLoad(() => api.health(), { poll: true });
  const discord = useLoad(() => api.discordStatus(), { poll: true });
  const profilesLoad = useLoad(() => api.listProfiles());
  const settings = useLoad(() => api.getSettings());

  // Préférence « Local Archive » : réglage serveur si présent, sinon localStorage.
  useEffect(() => {
    const v = settings.data?.localArchive;
    if (v !== undefined && v !== null) setLocalArchiveState(truthy(v));
  }, [settings.data]);
  const setLocalArchive = useCallback(async (on) => {
    setLocalArchiveState(on);
    localStorage.setItem('forget.localArchive', on ? 'on' : 'off');
    try {
      await api.patchSettings({ localArchive: on });
    } catch {
      /* conservé localement */
    }
  }, []);

  const profiles = Array.isArray(profilesLoad.data) ? profilesLoad.data : [];
  useEffect(() => {
    if (profiles.length && !profiles.some((p) => p.id === activeId)) setActiveId(profiles[0].id);
  }, [profiles, activeId, setActiveId]);
  const activeProfile = profiles.find((p) => p.id === activeId) || null;

  const apiOk = health.data ? true : health.error ? false : null;
  const ds = discord.data || { state: discord.loading ? 'loading' : 'apidown' };
  const navigate = useCallback((id) => {
    setPage(PAGES[id] ? id : 'home');
    window.scrollTo?.(0, 0);
  }, []);

  const ctx = useMemo(
    () => ({
      page, navigate, theme, setTheme, social: social.data || [], reloadSocial: social.reload,
      profiles, reloadProfiles: profilesLoad.reload, activeId, activeProfile, setActiveId,
      discord: ds, reloadDiscord: discord.reload,
      health: health.data, apiOk,
      localArchive, setLocalArchive, settings,
    }),
    [social.data, social.reload, page, navigate, theme, setTheme, profiles, profilesLoad.reload, activeId, activeProfile, setActiveId, ds, discord.reload, health.data, apiOk, localArchive, setLocalArchive, settings]
  );

  const Current = PAGES[page] || Home;

  return (
    <AppContext.Provider value={ctx}>
      <a className="skip-link" href="#contenu">Aller au contenu</a>
      <div className="shell">
        <Sidebar
          social={social.data || []}
          page={page}
          onNavigate={navigate}
          discordState={ds.state}
          discordUser={ds.user}
          archiveOn={localArchive}
          apiOk={apiOk}
          onAddAccount={() => setAddOpen(true)}
        />
        <div className="main">
          <JobsBanner onView={(provider) => navigate(provider)} />
          {apiOk === false && (
            <div className="notice error top-notice" role="alert">
              API indisponible. Vérifiez que le serveur tourne sur 127.0.0.1:4173.
            </div>
          )}
          <main id="contenu" className="content" tabIndex={-1}>
            <Current key={page} />
          </main>
        </div>
      </div>
      <Modal
        open={addOpen}
        title="Ajouter un compte"
        onClose={() => setAddOpen(false)}
        footer={<button type="button" className="btn" onClick={() => setAddOpen(false)}>Fermer</button>}
      >
        <p className="muted small">Choisissez la plateforme à relier à votre espace local.</p>
        <ul className="platform-list">
          <li>
            <div><strong>Discord</strong><div className="muted small">Votre propre compte, via votre token.</div></div>
            <button
              type="button"
              className="btn primary sm"
              data-autofocus
              onClick={() => { setAddOpen(false); navigate('overview'); }}
            >
              {ds.state === 'connected' ? 'Gérer' : 'Connecter'}
            </button>
          </li>
          <li>
            <div><strong>TikTok</strong><div className="muted small">Republications · votre session web, retrait cadencé.</div></div>
            <button className="btn primary sm" onClick={() => { setAddOpen(false); navigate('tiktok'); }}>Ouvrir</button>
          </li>
          {SOCIAL_PLATFORMS.map((p) => (
            <li key={p.id}>
              <div><strong>{p.name}</strong><div className="muted small">{['facebook','instagram'].includes(p.id) ? 'Compte personnel · nettoyage assisté.' : 'Publications · connexion OAuth utilisateur.'}</div></div>
              <button className="btn primary sm" onClick={() => { setAddOpen(false); navigate(p.id); }}>{['facebook','instagram'].includes(p.id) ? 'Ouvrir' : (social.data || []).some(s => s.provider === p.id && s.connected) ? 'Gérer' : 'Connecter'}</button>
            </li>
          ))}
        </ul>
      </Modal>
    </AppContext.Provider>
  );
}
