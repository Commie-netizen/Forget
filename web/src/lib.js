// Pure utilities shared by pages.

export const APP_VERSION = '4.3.0';

export function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
      if (p && typeof p === 'object') return [];
    } catch {
      /* plain string */
    }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// Accepts seconds, milliseconds, or an ISO string.
export function toMs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (/^\d+$/.test(String(ts))) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(ts);
  return Number.isNaN(d) ? null : d;
}

export function fmtDate(ts) {
  const ms = toMs(ts);
  if (!ms) return '-';
  return new Date(ms).toLocaleString("en-US", { dateStyle: 'short', timeStyle: 'medium' });
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '-';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

export const nf = (n) => Number(n || 0).toLocaleString("en-US");

// Date (ms) -> Discord snowflake. Used for minId/maxId/before/after bounds.
const DISCORD_EPOCH = 1420070400000n;
export function toSnowflake(ms) {
  if (!ms || ms < Number(DISCORD_EPOCH)) return '';
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}
export const dayStartMs = (iso) => (iso ? new Date(`${iso}T00:00:00`).getTime() : 0);
export const dayEndMs = (iso) => (iso ? new Date(`${iso}T23:59:59.999`).getTime() : 0);

export const JOB_LABEL = {
  queued: "Pending",
  pending: "Pending",
  running: "Running",
  cancelling: "Cancelling",
  succeeded: "Completed",
  completed: "Completed",
  done: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  active: 'Active',
  error: "Error",
};
export const JOB_TONE = {
  queued: 'neutral',
  pending: 'neutral',
  running: 'blue',
  cancelling: 'orange',
  succeeded: 'green',
  completed: 'green',
  done: 'green',
  failed: 'red',
  cancelled: 'orange',
  canceled: 'orange',
  active: 'blue',
  error: 'red',
};
export const isActive = (s) => s === 'queued' || s === 'pending' || s === 'running' || s === 'cancelling';

// Tolerant field access for normalized messages returned by the backend.
export const msgAuthor = (m) => m.author?.username || m.authorName || m.username || m.authorId || m.author?.id || '?';
export const msgDate = (m) => m.timestamp || m.createdAt || m.messageCreatedAt || m.date;
export const msgText = (m) => m.content ?? m.text ?? '';

// Normalize filters: lowercase, without accents.
export const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const matches = (text, query) => {
  const q = norm(query);
  return !q || norm(text).includes(q);
};
