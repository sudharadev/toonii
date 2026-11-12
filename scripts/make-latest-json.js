#!/usr/bin/env node
// Builds dist/latest.json, the manifest the in-app updater reads from the latest GitHub
// release. Run it after `tauri build` on each platform: it picks up the signed update
// bundles (*.sig next to the .app.tar.gz / -setup.exe) and merges them into the file, so a
// Windows build and a Mac build can each add their platforms. Upload latest.json and the
// update bundles to the release (tag v<version>).
//
//   node scripts/make-latest-json.js "What's new in this version"
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const repo = 'sudharadev/toonii';
const notes = process.argv[2] || '';
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target');
const out = path.join(root, 'dist', 'latest.json');

// [triple dir, bundle dir, file pattern, platforms it serves]
const kinds = [
  ['universal-apple-darwin', 'macos', /\.app\.tar\.gz$/, ['darwin-aarch64', 'darwin-x86_64']],
  ['aarch64-apple-darwin', 'macos', /\.app\.tar\.gz$/, ['darwin-aarch64']],
  ['x86_64-apple-darwin', 'macos', /\.app\.tar\.gz$/, ['darwin-x86_64']],
  ['', 'macos', /\.app\.tar\.gz$/, [process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64']],
  ['', 'nsis', new RegExp(`_${version.replace(/\./g, '\\.')}_x64-setup\\.exe$`), ['windows-x86_64']],
];

let manifest = { version, notes, pub_date: new Date().toISOString(), platforms: {} };
try {
  const old = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (old.version === version) manifest = { ...old, notes: notes || old.notes, pub_date: manifest.pub_date };
} catch { /* first platform for this version */ }

let found = 0;
for (const [triple, bundle, pattern, platforms] of kinds) {
  const dir = path.join(target, triple, 'release', 'bundle', bundle);
  if (!fs.existsSync(dir)) continue;
  const file = fs.readdirSync(dir).find((f) => pattern.test(f));
  if (!file || !fs.existsSync(path.join(dir, `${file}.sig`))) continue;
  const signature = fs.readFileSync(path.join(dir, `${file}.sig`), 'utf8').trim();
  // GitHub turns spaces in asset names into dots.
  const url = `https://github.com/${repo}/releases/download/v${version}/${file.replace(/ /g, '.')}`;
  for (const p of platforms) {
    if (manifest.platforms[p] && triple === '') continue; // a universal/arch build wins
    manifest.platforms[p] = { signature, url };
  }
  console.log(`${platforms.join(', ')}: ${path.join(dir, file)}`);
  found++;
}

if (!found) {
  console.error('No signed update bundles found. Build with TAURI_SIGNING_PRIVATE_KEY set first.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
