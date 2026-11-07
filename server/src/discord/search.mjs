// Search messages via the Discord search endpoint and paginate back to the oldest messages.
import { discordFetch, sleep } from './http.mjs';
import { normalizeMessage, cmpId } from './util.mjs';

export const SEARCH_PAGE = 25; // fixed Discord page size
export const MAX_OFFSET = 9975; // Discord offset cap

/** One search page. Guild -> /guilds/{id}/messages/search; otherwise (DM) -> /channels/{id}/messages/search. */
export async function searchPage(token, f, { pace, onRateLimit } = {}) {
  if (!f.guildId && !f.channelId) throw Object.assign(new Error('guildId or channelId is required'), { status: 400 });
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
    if (status === 202) { // index not ready: Discord asks for a retry
      await sleep(Math.ceil((data?.retry_after ?? 2) * 1000));
      continue;
    }
    // Each result is a group [context..., hit]: keep the matching message.
    const messages = (data?.messages ?? []).map((g) => g.find((m) => m.hit) ?? g[0]).filter(Boolean).map(normalizeMessage);
    return { total: data?.total_results ?? 0, messages };
  }
  throw Object.assign(new Error('Discord search index unavailable'), { status: 502 });
}

/** Collect messages matching the filters, newest to oldest, in steps of 25. When the offset reaches the Discord cap, restart at offset 0 with max_id = lowest ID seen. This reaches the earliest messages. Return results sorted oldest to newest. */
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
      if (freshSinceRestart === 0) break; // no progress: avoid an infinite loop
      maxId = minSeen;
      offset = 0;
      freshSinceRestart = 0;
    }
  }
  return out.sort((a, b) => cmpId(a.id, b.id));
}
