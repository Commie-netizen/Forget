// Local archive: written BEFORE any deletion/edit; CSV export. Nothing leaves the machine.
import * as store from './store.mjs';
import { csvCell as safeCell } from '../csv.mjs';

export function archiveMessage(msg, action, { meta, guildName, channelName } = {}) {
  return store.insertArchive({
    guildName: guildName ?? null,
    channelId: msg.channelId,
    channelName: channelName ?? null,
    messageId: msg.id,
    authorId: msg.authorId,
    content: msg.content,
    attachments: msg.attachments,
    messageCreatedAt: msg.timestamp,
    action,
    meta: { guildId: msg.guildId, ...meta },
  });
}

const CSV_COLS = ['id', 'platform', 'action', 'guildName', 'channelId', 'channelName', 'messageId', 'authorId', 'content', 'messageCreatedAt', 'archivedAt'];
const csvCell = (v) => safeCell(v, /[",\r\n]/);

export function toCsv(rows) {
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
