// Recherche de messages via l'endpoint search de Discord + pagination jusqu'aux plus vieux messages.
import { discordFetch, sleep } from './http.mjs';
import { normalizeMessage, cmpId } from './util.mjs';

export const SEARCH_PAGE = 25; // taille de page fixe côté Discord
export const MAX_OFFSET = 9975; // plafond d'offset de Discord

/** Une page de recherche. Guilde -> /guilds/{id}/messages/search, sinon (DM) -> /channels/{id}/messages/search. */
export async function searchPage(token, f, { pace, onRateLimit } = {}) {
  if (!f.guildId && !f.channelId) throw Object.assign(new Error('guildId ou channelId requis'), { status: 400 });
  const path = f.guildId ? `/guilds/${f.guildId}/messages/search` : `/channels/${f.channelId}/messages/search`;
  const query = {
    author_id: f.authorId,
    content: f.content,
    min_id: f.minId,
    max_id: f.maxId,
    channel_id: f.guildId ? f.channelId : undefined,
    offset: f.offset || 0,
    sort_by: 'timestamp',
    sort_order: 'desc',
  };
  for (let i = 0; i < 6; i++) {
    await pace?.();
    const { status, data } = await discordFetch(token, 'GET', path, { query, onRateLimit });
    if (status === 202) { // index pas prêt : Discord demande de réessayer
      await sleep(Math.ceil((data?.retry_after ?? 2) * 1000));
      continue;
    }
    // Chaque résultat est un groupe [contexte..., hit] : on garde le message touché.
    const messages = (data?.messages ?? []).map((g) => g.find((m) => m.hit) ?? g[0]).filter(Boolean).map(normalizeMessage);
    return { total: data?.total_results ?? 0, messages };
  }
  throw Object.assign(new Error('Index de recherche Discord indisponible'), { status: 502 });
}

/**
 * Collecte les messages correspondant aux filtres, du plus récent au plus ancien, par pas de 25.
 * Quand l'offset atteint le plafond Discord, on repart de offset 0 avec max_id = plus petit id vu :
 * cela permet de remonter jusqu'aux tout premiers messages. Résultat trié du plus ancien au plus récent.
 */
export async function collectMessages(token, filters, { max = Infinity, maxOffset = MAX_OFFSET, shouldStop, pace, onRateLimit, onPage } = {}) {
  const out = [];
  const seen = new Set();
  let offset = 0;
  let maxId = filters.maxId;
  let minSeen = null;
  let freshSinceRestart = 0;
  while (out.length < max && !shouldStop?.()) {
    const page = await searchPage(token, { ...filters, maxId, offset }, { pace, onRateLimit });
    if (!page.messages.length) break;
    for (const m of page.messages) {
      if (seen.has(m.id) || out.length >= max) continue;
      seen.add(m.id);
      out.push(m);
      freshSinceRestart++;
      if (minSeen === null || cmpId(m.id, minSeen) < 0) minSeen = m.id;
    }
    onPage?.(out.length, page.total);
    offset += SEARCH_PAGE;
    if (offset > maxOffset) {
      if (freshSinceRestart === 0) break; // aucun progrès : on évite la boucle infinie
      maxId = minSeen;
      offset = 0;
      freshSinceRestart = 0;
    }
  }
  return out.sort((a, b) => cmpId(a.id, b.id));
}
