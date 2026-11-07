import React from 'react';
import Icon from './Icon.jsx';
import Badge from './Badge.jsx';
import { APP_VERSION } from '../lib.js';

const ACCOUNTS = [
  { id: 'discord', label: 'Discord', letter: 'D', tone: 'red', page: 'discord' },
  { id: 'twitter', label: 'Twitter/X', letter: 'X', tone: 'blue' },
  { id: 'reddit', label: 'Reddit', letter: 'R', tone: 'orange' },
  { id: 'facebook', label: 'Facebook', letter: 'f', tone: 'navy' },
  { id: 'instagram', label: 'Instagram', letter: 'I', tone: 'pink' },
  { id: 'tiktok', label: 'TikTok', letter: 'T', tone: 'pink' },
];

function NavButton({ id, page, onNavigate, icon, children, right }) {
  const active = page === id;
  return (
    <button
      type="button"
      className={`nav-item${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(id)}
    >
      <Icon name={icon} />
      <span className="nav-label">{children}</span>
      {right}
    </button>
  );
}

export default function Sidebar({ social = [], page, onNavigate, discordState, discordUser, archiveOn, onAddAccount, apiOk }) {
  const connected = discordState === 'connected';
  const discordHint = connected
    ? "Connected"
    : discordState === 'unavailable'
      ? "Module unavailable"
      : "Not connected";
  return (
    <aside className="sidebar">
      <div className="logo" aria-label="Forget">
        <span className="logo-mark" aria-hidden="true" />
        FORGET
      </div>
      <nav aria-label="Main navigation" className="side-nav">
        <NavButton id="home" page={page} onNavigate={onNavigate} icon="home">Home</NavButton>

        <div className="nav-section">SOCIAL MEDIA</div>
        <NavButton id="overview" page={page} onNavigate={onNavigate} icon="grid">Overview</NavButton>

        <div className="nav-sub" id="accounts-label">Accounts</div>
        <ul className="accounts" aria-labelledby="accounts-label">
          {ACCOUNTS.map((a) => {
            const isDiscord = a.id === 'discord';
            const on = isDiscord && connected;
            if (!isDiscord) {
              return (
                <li key={a.id}>
                  <button type="button" className={`account${page === a.id ? ' active' : ''}`} aria-current={page === a.id ? 'page' : undefined} onClick={() => onNavigate(a.id)}>
                    <span className={`avatar tone-${a.tone}`} aria-hidden="true">{a.letter}</span>
                    <span className="account-name">{a.label}</span>
                    <span className="account-hint">{a.id === 'tiktok' ? 'reposts' : ['facebook','instagram'].includes(a.id) ? "guided" : social.some(s => s.provider === a.id && s.connected) ? "connected" : "not connected"}</span>
                  </button>
                </li>
              );
            }
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className={`account${page === 'discord' ? ' active' : ''}${on ? '' : ' dim'}`}
                  aria-current={page === 'discord' ? 'page' : undefined}
                  onClick={() => onNavigate('discord')}
                  title={discordUser?.username ? `${discordHint}: ${discordUser.username}` : discordHint}
                >
                  <span className={`avatar tone-${a.tone}`} aria-hidden="true">{a.letter}</span>
                  <span className="account-name">{a.label}</span>
                  {on ? (
                    <span className="account-live"><span className="dot up" aria-hidden="true" />Connected</span>
                  ) : (
                    <span className="account-hint">{discordHint.toLowerCase()}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="add-account" onClick={onAddAccount}>
          <Icon name="plus" size={16} /> Add account
        </button>

        <NavButton id="export" page={page} onNavigate={onNavigate} icon="archive">Export cleanup</NavButton>
        <NavButton id="schedule" page={page} onNavigate={onNavigate} icon="clock">Scheduling</NavButton>
        <NavButton id="disappearing" page={page} onNavigate={onNavigate} icon="eye">Disappearing Mode</NavButton>
        <NavButton
          id="archive"
          page={page}
          onNavigate={onNavigate}
          icon="archive"
          right={<Badge tone={archiveOn ? 'green' : 'neutral'}>{archiveOn ? 'ON' : 'OFF'}</Badge>}
        >
          Local Archive
        </NavButton>

        <div className="nav-section">PRIVACY TOOLS</div>
        <NavButton id="brokers" page={page} onNavigate={onNavigate} icon="shield" right={<Badge tone="blue">Beta</Badge>}>
          Data Brokers
        </NavButton>
      </nav>

      <div className="side-foot">
        <button type="button" className={`nav-item small${page === 'settings' ? ' active' : ''}`} onClick={() => onNavigate('settings')}>
          <Icon name="settings" size={16} /> <span className="nav-label">Settings</span>
        </button>
        <button type="button" className="nav-item small" onClick={() => { onNavigate('settings'); // Settings mounts before loading its data: wait for the card to appear.
          let n = 0; const go = () => { const el = document.getElementById('mise-a-jour'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); else if (n++ < 20) setTimeout(go, 50); }; setTimeout(go, 50); }}>
          <Icon name="refresh" size={16} /> <span className="nav-label">Update</span>
        </button>
        <div className="version">
          <span className={`dot ${apiOk === false ? 'down' : apiOk ? 'up' : ''}`} aria-hidden="true" />
          <span>Forget v{APP_VERSION}</span>
          <span className="muted">{typeof __APP_DATE__ !== 'undefined' ? __APP_DATE__ : ''}</span>
        </div>
      </div>
    </aside>
  );
}
