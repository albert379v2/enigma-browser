#!/usr/bin/env node
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const version = process.argv[2] || '2.1.5';
const setupName = `Enigma-Setup-${version}.exe`;
const url = `https://github.com/Abenezer-Mengistu/enigma-browser/releases/download/v${version}/${setupName}`;
const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'dist');

const res = await fetch(url, { headers: { 'User-Agent': 'Enigma-Browser' }, redirect: 'follow' });
if (!res.ok) throw new Error(`Download failed (${res.status})`);
const data = Buffer.from(await res.arrayBuffer());
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, setupName), data);

const sha512 = createHash('sha512').update(data).digest('base64');
const yml = `version: ${version}
files:
  - url: ${setupName}
    sha512: ${sha512}
    size: ${data.length}
path: ${setupName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
const ymlPath = join(outDir, 'latest.yml');
writeFileSync(ymlPath, yml);
console.log(`[fix] ${setupName}: ${data.length} bytes`);
console.log(`[fix] Wrote ${ymlPath}`);
