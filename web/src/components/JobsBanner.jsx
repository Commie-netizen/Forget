import React, { useEffect, useState } from 'react';
import * as api from '../api.js';
import { nf } from '../lib.js';

const BANNER_POLL_MS = 2000;

// Global banner (rendered by the shell): read-only, never cancels jobs.
export default function JobsBanner({ onView }) {
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    let alive = true;
    let timer = null;
    async function tick() {
      if (document.visibilityState === 'hidden') { timer = setTimeout(tick, BANNER_POLL_MS); return; } // hidden window: skip requests
      try {
        const [d, x, reddit, tiktok] = await Promise.all([
          api.discordActiveJobs(),
          api.get('/social/twitter/jobs').catch(() => []),
          api.get('/social/reddit/jobs').catch(() => []),
          api.get('/tiktok/jobs').catch(() => []),
        ]);
        if (!alive) return;
        setJobs([...(Array.isArray(d?.jobs) ? d.jobs.map(j => ({ ...j, provider: 'discord' })) : []),
          ...[...x, ...reddit].filter(j => ['queued', 'running', 'paused'].includes(j.status)).map(j => ({ ...j, progress: j.deleted })),
          ...(Array.isArray(tiktok) ? tiktok : []).filter(j => j.kind === 'remove' && ['running', 'paused', 'cooldown'].includes(j.status)).map(j => ({ ...j, provider: 'tiktok', progress: j.done }))]);
      } catch (e) {
        if (!alive) return;
        setJobs([]);
        if (api.isMissingEndpoint(e)) return; // missing endpoint: stop polling
      }
      timer = setTimeout(tick, BANNER_POLL_MS);
    }
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!jobs.length) return null;
  const done = jobs.reduce((n, j) => n + (Number(j.progress) || 0), 0);
  const total = jobs.reduce((n, j) => n + (Number(j.total) || 0), 0);
  return (
    <div className="jobs-banner" role="status" aria-live="polite">
      <span className="jobs-dot" aria-hidden="true" />
      <span className="grow">
        <strong>{nf(jobs.length)} operation{jobs.length > 1 ? 's' : ''} running</strong>
        {" · "}
        {nf(done)} / {total ? nf(total) : '?'}
      </span>
      <button type="button" className="btn sm" onClick={() => onView(jobs[0]?.provider || 'discord')}>View</button>
    </div>
  );
}
