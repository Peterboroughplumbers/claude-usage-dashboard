// Generates assets/icon.png (256x256) — a rounded orange square with a white bar chart glyph.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 256;
const px = new Uint8Array(S * S * 4);
const set = (x, y, r, g, b, a) => { const i = (y * S + x) * 4; px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a; };
const inRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), S - 1 - r), cy = Math.min(Math.max(y, r), S - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const bars = [[52, 150, 40], [108, 100, 40], [164, 60, 40]]; // x, top, width
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (!inRounded(x, y, 56)) { set(x, y, 0, 0, 0, 0); continue; }
  let inBar = false;
  for (const [bx, top, w] of bars) if (x >= bx && x < bx + w && y >= top && y < 208) inBar = true;
  if (inBar) set(x, y, 255, 255, 255, 255); else set(x, y, 217, 119, 87, 255);
}
const crc32 = (buf) => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', png);
console.log('assets/icon.png written');
