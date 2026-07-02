/**
 * Post-build fallback: patch unpacked exe (afterPack embeds icon before NSIS/portable).
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { rcedit } from 'rcedit';

const root = resolve(import.meta.dirname, '..');
const icon = join(root, 'assets', 'icons', 'icon.ico');

const targets = [
  join(root, 'dist', 'win-unpacked', 'Enigma.exe'),
  join(root, 'dist2', 'win-unpacked', 'Enigma.exe'),
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
];

for (const exe of targets) {
  if (!existsSync(exe)) continue;
  try {
    await rcedit(exe, { icon });
    console.log('Icon set:', exe.replace(root + '\\', ''));
  } catch (e) {
    console.warn('Skip (file locked?):', exe.replace(root + '\\', ''));
  }
}
