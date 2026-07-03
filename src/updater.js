'use strict';

const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const UPDATE_REPO = 'Abenezer-Mengistu/enigma-browser';
const UPDATE_PAGE = 'https://abenezer-mengistu.github.io/enigma-browser/';
const CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;

let mainWinRef = () => null;
let hasActiveDownloadsFn = () => false;
let shouldCheckUpdatesFn = () => true;
let pendingRelease = null;
let pendingInstall = null;
let downloading = false;
let updateReady = false;
let periodicTimer = null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowDowngrade = false;
autoUpdater.disableDifferentialDownload = true;

let suppressAutoUpdaterErrors = false;

function send(channel, payload) {
  mainWinRef()?.webContents.send(channel, payload);
}

function isPortableBuild() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

function parseVersion(v) {
  const m = String(v || '').replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

function isVersionNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function htmlToPlainText(input) {
  return decodeHtmlEntities(String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

function releaseNotesSnippet(body, maxLen = 120) {
  if (!body) return '';
  const text = htmlToPlainText(body)
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*•]\s+/gm, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^what'?s new/i.test(l) && !/^also in/i.test(l) && !/^bug fix/i.test(l))
    .slice(0, 1)
    .join(' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Enigma-Browser', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('Could not fetch release info');
  return res.json();
}

function pickAsset(release, portable) {
  const assets = release.assets || [];
  if (portable) {
    return assets.find(a => /^Enigma-Portable-.*\.exe$/i.test(a.name));
  }
  return assets.find(a => /^Enigma-Setup-.*\.exe$/i.test(a.name));
}

function buildUpdateResult(base, extra = {}) {
  return { ...base, ...extra };
}

function assetDownloadUrl(asset) {
  return asset?.browser_download_url || asset?.url || '';
}

async function downloadAsset(url, dest, onProgress) {
  if (!url) throw new Error('No download URL for update');
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Enigma-Browser', Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') || 0);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const file = fs.createWriteStream(dest);
  let received = 0;
  let lastTime = Date.now();
  let lastReceived = 0;
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error('Download stream unavailable');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise((resolve, reject) => {
        file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      const percent = total ? (received / total) * 100 : 0;
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      let bytesPerSecond = 0;
      let etaSeconds = 0;
      if (elapsed >= 0.4) {
        bytesPerSecond = (received - lastReceived) / elapsed;
        etaSeconds = total && bytesPerSecond > 0 ? (total - received) / bytesPerSecond : 0;
        lastTime = now;
        lastReceived = received;
      }
      onProgress?.({ percent, transferred: received, total, bytesPerSecond, etaSeconds });
    }
  } finally {
    await new Promise((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
  }
  return dest;
}

function runInstallerAndQuit(installerPath) {
  const args = process.platform === 'win32' ? ['--updated', '/S'] : [];
  const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

function runPortableAndQuit(portablePath) {
  const child = spawn(portablePath, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(portablePath),
  });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

async function applyPortableUpdate(downloadedPath, assetName) {
  const currentExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const targetDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(currentExe);
  const targetPath = path.join(targetDir, assetName || path.basename(downloadedPath));

  try {
    await fs.promises.access(targetDir, fs.constants.W_OK);
  } catch {
    throw new Error('Cannot write to the portable folder — move Enigma to a writable location');
  }

  const backupPath = `${currentExe}.old`;
  try { await fs.promises.unlink(backupPath); } catch { /* ignore */ }

  if (fs.existsSync(currentExe)) {
    await fs.promises.copyFile(currentExe, backupPath);
  }

  await fs.promises.copyFile(downloadedPath, targetPath);

  const launchPath = path.normalize(targetPath);
  if (!fs.existsSync(launchPath)) {
    throw new Error('Updated portable file could not be written');
  }

  runPortableAndQuit(launchPath);
}

function markUpdateReady(version, mode) {
  updateReady = true;
  downloading = false;
  send('update-downloaded', { version, mode, ready: true });
}

function initUpdater(getMainWindow, opts = {}) {
  mainWinRef = getMainWindow;
  hasActiveDownloadsFn = opts.hasActiveDownloads || (() => false);
  shouldCheckUpdatesFn = opts.shouldCheckUpdates || (() => true);

  autoUpdater.on('download-progress', (p) => {
    send('update-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      etaSeconds: p.bytesPerSecond > 0 && p.total
        ? (p.total - p.transferred) / p.bytesPerSecond
        : 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    downloading = false;
    pendingInstall = { mode: 'autoUpdater', version: info.version };
    send('update-downloaded', { version: info.version, mode: 'autoUpdater', ready: true });
  });

  autoUpdater.on('error', () => {
    if (suppressAutoUpdaterErrors) return;
    downloading = false;
    send('update-error', { message: 'Update check failed' });
  });

  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = setInterval(async () => {
    if (!app.isPackaged || !shouldCheckUpdatesFn()) return;
    try {
      const result = await checkForUpdates();
      if (result.available) send('update-available', result);
    } catch { /* ignore background check errors */ }
  }, CHECK_INTERVAL_MS);
}

async function checkForUpdates() {
  const current = app.getVersion();
  const base = {
    currentVersion: current,
    latestVersion: current,
    available: false,
    url: UPDATE_PAGE,
    downloadUrl: UPDATE_PAGE,
    releaseNotes: '',
    portable: isPortableBuild(),
    canAutoUpdate: app.isPackaged,
    ready: updateReady,
  };

  try {
    if (updateReady && pendingInstall?.version) {
      return buildUpdateResult(base, {
        available: true,
        ready: true,
        latestVersion: pendingInstall.version,
        releaseNotes: pendingRelease?.releaseNotes || '',
      });
    }

    const release = await fetchLatestRelease();
    const latest = (release.tag_name || '').replace(/^v/i, '');
    const notes = releaseNotesSnippet(release.body || '');
    const asset = pickAsset(release, isPortableBuild());
    pendingRelease = { release, version: latest, via: 'github', releaseNotes: notes };
    return buildUpdateResult(base, {
      available: isVersionNewer(latest, current),
      latestVersion: latest,
      url: release.html_url || UPDATE_PAGE,
      downloadUrl: assetDownloadUrl(asset) || UPDATE_PAGE,
      assetName: asset?.name || null,
      releaseNotes: notes,
    });
  } catch {
    return base;
  }
}

async function downloadViaGithub() {
  const release = pendingRelease?.release || await fetchLatestRelease();
  const portable = isPortableBuild();
  const asset = pickAsset(release, portable);
  const url = assetDownloadUrl(asset);
  if (!url) throw new Error('No update installer found for this build');

  const dest = path.join(app.getPath('temp'), 'enigma-updates', asset.name);
  await downloadAsset(url, dest, (p) => send('update-progress', p));

  const version = (pendingRelease?.version || release.tag_name || '').replace(/^v/i, '');
  const mode = portable ? 'portable' : 'installer';
  pendingRelease = { ...pendingRelease, release, version, via: 'github' };
  pendingInstall = { path: dest, mode, version, assetName: asset.name };
  markUpdateReady(version, mode);
  return { ok: true, mode, ready: true };
}

async function downloadUpdate() {
  if (downloading) return { ok: false, reason: 'busy' };
  if (!app.isPackaged) {
    shell.openExternal(UPDATE_PAGE);
    return { ok: false, reason: 'dev' };
  }
  if (updateReady) return { ok: true, ready: true, mode: pendingInstall?.mode };

  downloading = true;
  updateReady = false;
  pendingInstall = null;
  suppressAutoUpdaterErrors = true;
  send('update-progress', { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, etaSeconds: 0 });

  try {
    return await downloadViaGithub();
  } catch (e) {
    downloading = false;
    send('update-error', { message: e?.message || String(e) });
    throw e;
  } finally {
    suppressAutoUpdaterErrors = false;
  }
}

async function installUpdate({ force = false } = {}) {
  if (!updateReady && !pendingInstall) {
    if (pendingRelease?.via === 'autoUpdater' && !isPortableBuild()) {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    }
    return { ok: false, reason: 'not-ready' };
  }

  if (!force && hasActiveDownloadsFn()) {
    return { ok: false, reason: 'downloads-active' };
  }

  if (pendingInstall?.mode === 'autoUpdater' || pendingRelease?.via === 'autoUpdater') {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  if (!pendingInstall?.path) return { ok: false, reason: 'not-ready' };

  if (pendingInstall.mode === 'portable') {
    await applyPortableUpdate(pendingInstall.path, pendingInstall.assetName);
    return { ok: true };
  }

  runInstallerAndQuit(pendingInstall.path);
  return { ok: true };
}

function quitAndInstall() {
  return installUpdate();
}

function getUpdateStatus() {
  return {
    downloading,
    ready: updateReady,
    version: pendingInstall?.version || pendingRelease?.version || null,
    mode: pendingInstall?.mode || pendingRelease?.via || null,
  };
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  quitAndInstall,
  getUpdateStatus,
  isPortableBuild,
};
