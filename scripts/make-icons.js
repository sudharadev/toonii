// Generates the Toonii app icon (googly eyes on a Toon card) as plain PNG/ICO files, no
// dependencies: assets/icon.png (1024, macOS + Linux), assets/icon.ico (Windows, 16-256)
// and the tray icons. Run with `npm run icons`.
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

const circle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

const INK = [23, 23, 28];
const PAPER = [255, 216, 77];
const WHITE = [255, 255, 255];

// Layers are painted back to front; every shape is a signed distance in pixels.
function paint(x, y, layers) {
  let px = [0, 0, 0, 0];
  for (const [rgb, d] of layers) px = over(px, rgb, cover(d));
  return px.map((v, i) => (i < 3 ? Math.round(v) : v));
}

// Eye: outlined white ball with a pupil and a glint, looking up and to the right.
function eyeLayers(x, y, s, cx, cy, r, line) {
  const pr = r * 0.48;
  const pcx = cx + r * 0.22;
  const pcy = cy - r * 0.1;
  return [
    [INK, circle(x, y, cx, cy, r) * s],
    [WHITE, circle(x, y, cx, cy, r) * s + line],
    [INK, circle(x, y, pcx, pcy, pr) * s],
    [WHITE, circle(x, y, pcx - pr * 0.35, pcy - pr * 0.35, pr * 0.34) * s],
  ];
}

function appPixel(x, y, s) {
  const u = x / s;
  const v = y / s;
  const line = Math.max(1, s * 0.042);
  const card = (ox, oy) => roundRect(u, v, 0.47 + ox, 0.47 + oy, 0.385, 0.385, 0.17) * s;
  const off = Math.max(1, s * 0.045) / s;
  return paint(x, y, [
    [INK, card(off, off)], // hard cartoon shadow
    [INK, card(0, 0)],
    [PAPER, card(0, 0) + line],
    ...eyeLayers(u, v, s, 0.315, 0.47, 0.145, line * 0.85),
    ...eyeLayers(u, v, s, 0.625, 0.47, 0.145, line * 0.85),
  ]);
}

// Tray: just the eyes, so they stay readable at 16px on light and dark taskbars.
function trayPixel(x, y, s) {
  const u = x / s;
  const v = y / s;
  const line = Math.max(1, s * 0.09);
  return paint(x, y, [
    ...eyeLayers(u, v, s, 0.26, 0.5, 0.235, line),
    ...eyeLayers(u, v, s, 0.74, 0.5, 0.235, line),
  ]);
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function encodeIco(sizes, pixel) {
  const pngs = sizes.map((size) => encodePng(size, pixel));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['icon.png', encodePng(1024, appPixel)],
  ['icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256], appPixel)],
  ['tray.png', encodePng(16, trayPixel)],
  ['tray@2x.png', encodePng(32, trayPixel)],
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(out, name), buf);
  console.log('wrote', name);
}
