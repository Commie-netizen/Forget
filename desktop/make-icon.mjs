// Genere assets/icon.ico (256x256, fond rouge #e5484d, lettre R blanche) sans dependance.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const N = 256;
const R = ['1111.', '1...1', '1...1', '1111.', '1.1..', '1..1.', '1...1']; // glyphe 5x7

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function makePng() {
  const cell = 24, gw = 5 * cell, gh = 7 * cell, ox = (N - gw) / 2, oy = (N - gh) / 2;
  const stride = N * 4 + 1;
  const raw = Buffer.alloc(stride * N);
  const rad = 48;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = y * stride + 1 + x * 4;
      const cx = Math.min(Math.max(x, rad), N - 1 - rad), cy = Math.min(Math.max(y, rad), N - 1 - rad);
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
      const gx = Math.floor((x - ox) / cell), gy = Math.floor((y - oy) / cell);
      const glyph = x >= ox && y >= oy && gx < 5 && gy < 7 && R[gy][gx] === '1';
      const [r, g, b] = glyph ? [255, 255, 255] : [0xe5, 0x48, 0x4d];
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function makeIco() {
  const png = makePng();
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // type icone, 1 image
  head[6] = 0; head[7] = 0; // 0 = 256 px
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'assets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'icon.ico'), makeIco());
  console.log('icon.ico ecrit');
}
