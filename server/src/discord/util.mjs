// Utilitaires partagés : snowflakes Discord, normalisation des messages, parsing de dates.
export const DISCORD_EPOCH = 1420070400000n;
// Limite Discord du bulk-delete : messages de moins de 14 jours (marge de 10 min).
export const BULK_MAX_AGE_MS = 14 * 24 * 3600 * 1000 - 10 * 60 * 1000;

export const snowflakeToMs = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

export function msToSnowflake(ms) {
  const rel = BigInt(Math.floor(ms)) - DISCORD_EPOCH;
  return (rel > 0n ? rel << 22n : 0n).toString();
}

export function cmpId(a, b) {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Accepte un id snowflake, un timestamp en ms ou une date ISO ; renvoie un snowflake ou undefined.
export function toSnowflake(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d{15,}$/.test(s)) return s;
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(ms) ? msToSnowflake(ms) : undefined;
}

// Date/ms -> ms (ou undefined) pour les filtres d'archive.
export function parseTime(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

// Message brut Discord -> forme normalisée utilisée partout dans le module.
export function normalizeMessage(raw) {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    guildId: raw.guild_id ?? null,
    authorId: raw.author?.id ?? null,
    authorName: raw.author?.username ?? null,
    content: raw.content ?? '',
    timestamp: Date.parse(raw.timestamp) || snowflakeToMs(raw.id),
    editedTimestamp: raw.edited_timestamp ? Date.parse(raw.edited_timestamp) : null,
    type: raw.type ?? 0,
    pinned: !!raw.pinned,
    attachments: (raw.attachments ?? []).map((a) => ({
      id: a.id, filename: a.filename, url: a.url, size: a.size, contentType: a.content_type ?? null,
    })),
  };
}

export function maskToken(token) {
  if (!token) return null;
  return token.length <= 8 ? '••••' : '••••••••' + token.slice(-4);
}

/**
 * Filtres de protection appliqués localement avant toute suppression/édition (hors sélection explicite) :
 * keepPinned (conserver les épinglés), onlyAttachments, excludeWords (aucun message contenant ces mots).
 * Renvoie null si aucun filtre n'est actif.
 */
export function protectionFilter(p = {}) {
  const words = (Array.isArray(p.excludeWords) ? p.excludeWords : [])
    .map((w) => String(w).toLowerCase().trim()).filter(Boolean);
  if (!p.keepPinned && !p.onlyAttachments && !words.length) return null;
  return (m) => {
    if (p.keepPinned && m.pinned) return false;
    if (p.onlyAttachments && !(m.attachments?.length)) return false;
    if (words.length) {
      const text = String(m.content ?? '').toLowerCase();
      if (words.some((w) => text.includes(w))) return false;
    }
    return true;
  };
}

/** Valide et normalise les options de protection reçues de l'API. */
export function protectionParams(b = {}) {
  const words = Array.isArray(b.excludeWords) ? b.excludeWords
    : typeof b.excludeWords === 'string' ? b.excludeWords.split(',') : [];
  const excludeWords = [...new Set(words.map((w) => String(w).trim()).filter(Boolean).map((w) => w.slice(0, 100)))].slice(0, 50);
  return { keepPinned: b.keepPinned === true, onlyAttachments: b.onlyAttachments === true, excludeWords };
}
