// Generates assets/icon.png (512) and tray icons as plain PNGs, no dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));

function over(dst, rgb, a) {
  const outA = a + dst[3] * (1 - a);
  if (outA === 0) return [0, 0, 0, 0];
  const mix = (i) => (rgb[i] * a + dst[i] * dst[3] * (1 - a)) / outA;
  return [mix(0), mix(1), mix(2), outA];
}

function notePixel(x, y, s) {
  let px = [0, 0, 0, 0];
  const pad = s * 0.08;
  const half = (s - pad * 2) / 2;
  px = over(px, [255, 217, 102], cover(roundRect(x, y, s / 2, s / 2, half, half, s * 0.18)));
  const ink = [138, 90, 0];
  const t = Math.max(1, s * 0.07);
  const lines = [[0.36, 0.72], [0.52, 0.72], [0.68, 0.56]];
  for (const [ly, lx2] of lines) {
    const x1 = s * 0.28, x2 = s * lx2;
    const d = roundRect(x, y, (x1 + x2) / 2, s * ly, (x2 - x1) / 2, t / 2, t / 2);
    px = over(px, ink, cover(d) * 0.75);
  }
  return px.map((v, i) => (i < 3 ? Math.round(v) : v));
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [['icon.png', 512], ['tray.png', 16], ['tray@2x.png', 32]]) {
  fs.writeFileSync(path.join(out, name), encodePng(size, notePixel));
  console.log('wrote', name);
}
