/**
 * Embed Enigma icon into the packaged .exe BEFORE NSIS/portable targets run.
 * (Post-build rcedit was too late — installers already contained Electron's icon.)
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { rcedit } from 'rcedit';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const root = resolve(import.meta.dirname, '..');
  const icon = join(root, 'assets', 'icons', 'icon.ico');
  if (!existsSync(icon)) {
    console.warn('[afterPack] icon.ico missing — run npm run build:icon');
    return;
  }

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = join(context.appOutDir, exeName);
  if (!existsSync(exe)) {
    console.warn('[afterPack] executable not found:', exeName);
    return;
  }

  await rcedit(exe, { icon });
  console.log('[afterPack] Enigma icon embedded in', exeName);
}
