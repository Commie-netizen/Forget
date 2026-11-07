// Lecture ZIP à mémoire bornée : on parcourt le répertoire central, puis on lit UNIQUEMENT les entrées retenues,
// une à la fois, avec des plafonds de taille décompressée (protection contre les bombes ZIP). Rien n'est écrit
// sur disque, aucun chemin de l'archive n'est utilisé comme chemin de fichier. ZIP64 pris en charge.
import { open } from 'node:fs/promises';
import { Inflate } from 'fflate';

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CDH = 0x02014b50, SIG_LFH = 0x04034b50;
const MAX_CENTRAL_DIR = 256 * 1024 * 1024;
const fail = (m) => { throw new Error(m); };

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) fail('Archive ZIP tronquée');
  return buf;
}

async function centralDirectory(fh, size) {
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await readAt(fh, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
  if (e < 0) fail('Archive ZIP invalide');
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_Z64_LOC) fail('Archive ZIP64 invalide');
    const z = await readAt(fh, 56, Number(tail.readBigUInt64LE(loc + 8)));
    if (z.readUInt32LE(0) !== SIG_Z64_EOCD) fail('Archive ZIP64 invalide');
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  if (cdSize > MAX_CENTRAL_DIR || cdOff + cdSize > size) fail('Répertoire ZIP invalide ou trop volumineux');
  return { count, cd: await readAt(fh, cdSize, cdOff) };
}

/**
 * Itère sur les entrées dont le nom est accepté : { name, data(Buffer) }.
 * maxEntry : taille décompressée max par entrée ; maxTotal : total décompressé max pour l'archive.
 */
export async function* zipEntries(path, accept, { maxEntry = 64 * 1024 ** 2, maxTotal = 2 * 1024 ** 3, tooBig = 'Export trop volumineux' } = {}) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const { count, cd } = await centralDirectory(fh, size);
    let p = 0, total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CDH) fail('Répertoire ZIP invalide');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), loff = cd.readUInt32LE(p + 42);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
      for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end;) { // champ ZIP64 (0x0001)
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
      if (flags & 1) fail('Archive ZIP chiffrée non prise en charge');
      if (method !== 0 && method !== 8) fail(`Compression ZIP non prise en charge (${method})`);
      if (loff + 30 > size || csize > size) fail('Entrée ZIP invalide');
      const lfh = await readAt(fh, 30, loff);
      if (lfh.readUInt32LE(0) !== SIG_LFH) fail('Entrée ZIP invalide');
      let pos = loff + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
      const stop = pos + csize;
      if (stop > size) fail('Entrée ZIP tronquée');
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
