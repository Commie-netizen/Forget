// Read ZIP files with bounded memory: scan the central directory, then read ONLY selected entries,
// one at a time, with decompressed size limits (ZIP bomb protection). Nothing is written
// to disk; archive paths are never used as filesystem paths. ZIP64 is supported.
import { open } from 'node:fs/promises';
import { Inflate } from 'fflate';

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CDH = 0x02014b50, SIG_LFH = 0x04034b50;
const MAX_CENTRAL_DIR = 256 * 1024 * 1024;
const fail = (m) => { throw new Error(m); };

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) fail('Truncated ZIP archive');
  return buf;
}

async function centralDirectory(fh, size) {
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await readAt(fh, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
  if (e < 0) fail('Invalid ZIP archive');
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_Z64_LOC) fail('Invalid ZIP64 archive');
    const z = await readAt(fh, 56, Number(tail.readBigUInt64LE(loc + 8)));
    if (z.readUInt32LE(0) !== SIG_Z64_EOCD) fail('Invalid ZIP64 archive');
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  if (cdSize > MAX_CENTRAL_DIR || cdOff + cdSize > size) fail('Invalid or oversized ZIP central directory');
  return { count, cd: await readAt(fh, cdSize, cdOff) };
}

/** Iterate over entries with accepted names: { name, data(Buffer) }. maxEntry: maximum decompressed size per entry; maxTotal: maximum decompressed size for the archive. */
export async function* zipEntries(path, accept, { maxEntry = 64 * 1024 ** 2, maxTotal = 2 * 1024 ** 3, tooBig = 'Export too large' } = {}) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const { count, cd } = await centralDirectory(fh, size);
    let p = 0, total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CDH) fail('Invalid ZIP central directory');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), loff = cd.readUInt32LE(p + 42);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
      for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end;) { // ZIP64 field (0x0001)
        const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (loff === 0xffffffff) loff = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + sz;
      }
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/') || !accept(name)) continue;
      if (flags & 1) fail('Encrypted ZIP archives are not supported');
      if (method !== 0 && method !== 8) fail(`Unsupported ZIP compression (${method})`);
      if (loff + 30 > size || csize > size) fail('Invalid ZIP entry');
      const lfh = await readAt(fh, 30, loff);
      if (lfh.readUInt32LE(0) !== SIG_LFH) fail('Invalid ZIP entry');
      let pos = loff + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
      const stop = pos + csize;
      if (stop > size) fail('Truncated ZIP entry');
      const out = [];
      let got = 0;
      const take = (chunk) => {
        got += chunk.length; total += chunk.length;
        if (got > maxEntry || total > maxTotal) fail(tooBig);
        out.push(chunk);
      };
      const inflate = method === 8 ? new Inflate((chunk) => take(Buffer.from(chunk))) : null;
      while (pos < stop) {
        const len = Math.min(64 * 1024, stop - pos);
        const chunk = await readAt(fh, len, pos);
        pos += len;
        if (inflate) inflate.push(chunk, pos >= stop); else take(chunk);
      }
      if (inflate && csize === 0) inflate.push(new Uint8Array(0), true);
      yield { name, data: Buffer.concat(out) };
    }
  } finally { await fh.close(); }
}
