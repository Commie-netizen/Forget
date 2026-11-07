const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      // X-Forget-Request: required by the server for all writes (CSRF protection, see server/src/security.mjs).
      headers: { 'X-Forget-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("API unavailable", 0);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : res.status >= 500 ? "API unavailable" : `Error ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const get = (p) => request('GET', p);
export const post = (p, b) => request('POST', p, b === undefined ? {} : b);
export const patch = (p, b) => request('PATCH', p, b);
export const put = (p, b) => request('PUT', p, b);
export const del = (p) => request('DELETE', p);

// Builds a query string, skipping empty values.
export function qs(params) {
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---- Legacy contract (SPEC.md) ----
export const health = () => get('/health');

export const listProfiles = () => get('/profiles');
export const getProfile = (id) => get(`/profiles/${id}`);
export const createProfile = (b) => post('/profiles', b);
export const updateProfile = (id, b) => patch(`/profiles/${id}`, b);
export const deleteProfile = (id) => del(`/profiles/${id}`);

export const listClaws = () => get('/claws');
export const scanClaw = (id, profileId) => post(`/claws/${id}/scan`, { profileId });

export const listScanJobs = () => get('/scan-jobs');
export const getScanJob = (id) => get(`/scan-jobs/${id}`);
export const getScanResult = (id) => get(`/scan-results/${id}`);
export const requestRemoval = (resultId) => post(`/scan-results/${resultId}/removal`);
export const listRemovalJobs = () => get('/removal-jobs');
export const getRemovalJob = (id) => get(`/removal-jobs/${id}`);

export const listAxes = () => get('/axes');
export const listAxeJobs = () => get('/axe-jobs');

export const listSchedules = () => get('/schedules');
export const createSchedule = (b) => post('/schedules', b);
export const deleteSchedule = (id) => del(`/schedules/${id}`);

export const exportUrl = (format) => `${BASE}/export?format=${encodeURIComponent(format)}`;
export const listEvents = (limit = 50) => get(`/events?limit=${limit}`);

export const getSettings = () => get('/settings');
export const patchSettings = (b) => patch('/settings', b);

// ---- Discord (SPEC-V2 section 1) ----
const D = '/discord';

/**
 * Discord status with graceful fallback:
 *  - connected             -> { state:'connected', ...status }
 *  - 409 / connected:false -> { state:'disconnected' }
 *  - 404 / 501 / 503       -> { state:'unavailable' } (Discord module missing)
 *  - network unavailable  -> { state:'apidown' }
 */
export async function discordStatus() {
  try {
    const s = (await get(`${D}/status`)) || {};
    return { ...s, state: s.connected ? 'connected' : 'disconnected' };
  } catch (e) {
    if (e.status === 409) return { state: 'disconnected', connected: false };
    if (e.status === 404 || e.status === 501 || e.status === 503) return { state: 'unavailable', connected: false };
    if (e.status === 0) return { state: 'apidown', connected: false };
    return { state: 'error', connected: false, error: e.message };
  }
}

export const discordLoginWindow = () => post(`${D}/login-window`);
export const discordActiveJobs = () => get(`${D}/jobs/active`);
export const security = () => get('/security');
export const discordSetToken = (token) => post(`${D}/token`, { token });
export const discordClearToken = () => del(`${D}/token`);
export const discordMe = () => get(`${D}/me`);
export const discordGuilds = () => get(`${D}/guilds`);
export const discordDms = () => get(`${D}/dms`);
export const discordMessages = (channelId, p = {}) =>
  get(`${D}/channels/${channelId}/messages${qs({ limit: 50, ...p })}`);
export const discordSearch = (p = {}) => get(`${D}/search${qs({ limit: 25, ...p })}`);
export const discordDeleteJob = (b) => post(`${D}/jobs/delete`, b);
export const discordEditJob = (b) => post(`${D}/jobs/edit`, b);
export const discordPreviewJob = (b) => post(`${D}/jobs/preview`, b);
export const discordJobs = () => get(`${D}/jobs`);
export const discordJob = (id) => get(`${D}/jobs/${id}`);
export const discordCancelJob = (id) => post(`${D}/jobs/${id}/cancel`);
export const discordArchive = (p = {}) => get(`${D}/archive${qs({ limit: 100, ...p })}`);
export const discordArchiveExportUrl = (format) => `${BASE}${D}/archive/export?format=${encodeURIComponent(format)}`;
export const discordDisappearing = () => get(`${D}/disappearing`);
export const discordSetDisappearing = (b) => patch(`${D}/disappearing`, b);

// ---- Scheduled purges (SPEC-V4 B2) ----
export const discordPurges = () => get(`${D}/purges`);
export const discordCreatePurge = (b) => post(`${D}/purges`, b);
export const discordRunPurge = (id) => post(`${D}/purges/${id}/run`);
export const discordCancelPurge = (id) => del(`${D}/purges/${id}`);

// ---- Bulk broker scan (SPEC-V4 B3) ----
export const scanAllClaws = (profileId) => post('/claws/scan-all', { profileId });

// Checks whether an API error means a missing endpoint (404/501/503) for graceful UI fallback.
export const isMissingEndpoint = (e) => !!e && (e.status === 404 || e.status === 501 || e.status === 503);
