const {
  app, BrowserWindow, session, ipcMain, Menu, shell, clipboard, screen, nativeImage, nativeTheme, dialog
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');
const { isSafeExternalUrl, isNavigableUrl, hardenSession, FINGERPRINT_INJECT, FORCE_LIGHT_PAGE } = require('./security');
const { listTemplates } = require('./session-templates');
const { DEFAULT_PRIVACY, effectiveSettings } = require('./privacy-store');
const { encryptVault, decryptVault } = require('./sync-crypto');
const { sharedEngine } = require('./filter-engine');
const {
  initUpdater, checkForUpdates, downloadUpdate, installUpdate, quitAndInstall, getUpdateStatus,
} = require('./updater');

app.setName('Enigma');
if (process.platform === 'win32') app.setAppUserModelId('app.enigmabrowser');

/** Always use OS app-data — never store profiles beside a portable/USB .exe */
function resolveUserDataRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Enigma');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Enigma');
  }
  return path.join(os.homedir(), '.config', 'Enigma');
}
app.setPath('userData', resolveUserDataRoot());

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('disable-features', 'WebContentsForceDark');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');

const DATA = app.getPath('userData');
const USERS_ROOT = path.join(DATA, 'users');
const REGISTRY_PATH = path.join(USERS_ROOT, 'registry.json');
const INSTALL_BINDING_PATH = path.join(DATA, 'install-binding.json');
const LEGACY_PATHS = {
  history: path.join(DATA, 'history.json'),
  bookmarks: path.join(DATA, 'bookmarks.json'),
  settings: path.join(DATA, 'settings.json'),
  session: path.join(DATA, 'session.json'),
  notes: path.join(DATA, 'notes.txt'),
};

let activeUserId = 'u_default';

function userDir(userId) {
  const dir = path.join(USERS_ROOT, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userPaths(userId = activeUserId) {
  const dir = userDir(userId);
  return {
    history: path.join(dir, 'history.json'),
    bookmarks: path.join(dir, 'bookmarks.json'),
    settings: path.join(dir, 'settings.json'),
    session: path.join(dir, 'session.json'),
    notes: path.join(dir, 'notes.txt'),
  };
}

function sessionPartition(userId, sessionId, ephemeral) {
  const prefix = ephemeral ? 'partition' : 'persist';
  return `${prefix}:u${userId}_s_${sessionId}`;
}

function mainPartition(userId = activeUserId) {
  return `persist:u${userId}_main`;
}

function machineFingerprint() {
  const parts = [os.hostname(), os.userInfo().username, process.platform, 'enigma-v1'];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function wipeAllLocalData() {
  try {
    if (fs.existsSync(USERS_ROOT)) fs.rmSync(USERS_ROOT, { recursive: true, force: true });
    for (const legacy of Object.values(LEGACY_PATHS)) {
      try { if (fs.existsSync(legacy)) fs.unlinkSync(legacy); } catch {}
    }
    const partsDir = path.join(DATA, 'Partitions');
    if (fs.existsSync(partsDir)) fs.rmSync(partsDir, { recursive: true, force: true });
    try { if (fs.existsSync(INSTALL_BINDING_PATH)) fs.unlinkSync(INSTALL_BINDING_PATH); } catch {}
  } catch (e) { console.error('[wipeAllLocalData]', e); }
}

/** Bind profile storage to this computer — new machine = fresh start */
function ensureMachineBinding() {
  fs.mkdirSync(DATA, { recursive: true });
  const machineId = machineFingerprint();
  const binding = read(INSTALL_BINDING_PATH, null);
  const hadUsers = fs.existsSync(REGISTRY_PATH);

  if (!binding) {
    write(INSTALL_BINDING_PATH, {
      machineId,
      boundAt: Date.now(),
      appVersion: app.getVersion(),
    });
    return !hadUsers;
  }

  if (binding.machineId !== machineId) {
    wipeAllLocalData();
    write(INSTALL_BINDING_PATH, {
      machineId,
      boundAt: Date.now(),
      appVersion: app.getVersion(),
    });
    return true;
  }
  return false;
}

function emptySessionSeed(color = '#8b5cf6') {
  return {
    profiles: [{ id: 'default', name: 'Main', color, isIncognito: false, ephemeral: false, partition: null }],
    activePid: 'default',
    tabsByPid: { default: [] },
    activeTid: { default: null },
  };
}

function privacyPresetSettings(preset) {
  if (preset === 'strict') {
    return {
      blockTrackers: true,
      httpsOnly: true,
      doNotTrack: true,
      blockPopups: true,
      filterLists: true,
      fingerprintProtection: true,
      webrtcProtection: true,
      mixedContentBlock: true,
    };
  }
  if (preset === 'relaxed') {
    return {
      blockTrackers: false,
      httpsOnly: false,
      doNotTrack: false,
      blockPopups: true,
      filterLists: false,
      fingerprintProtection: false,
      webrtcProtection: false,
      mixedContentBlock: false,
    };
  }
  return {
    blockTrackers: true,
    httpsOnly: false,
    doNotTrack: true,
    blockPopups: true,
    filterLists: true,
    fingerprintProtection: true,
    webrtcProtection: true,
    mixedContentBlock: false,
  };
}

function privacyPresetDoc(preset) {
  if (preset === 'strict') {
    return {
      ...DEFAULT_PRIVACY,
      filterLists: true,
      fingerprintProtection: true,
      webrtcProtection: true,
      mixedContentBlock: true,
    };
  }
  if (preset === 'relaxed') {
    return {
      ...DEFAULT_PRIVACY,
      filterLists: false,
      fingerprintProtection: false,
      webrtcProtection: false,
      mixedContentBlock: false,
    };
  }
  return { ...DEFAULT_PRIVACY };
}

function seedUserFiles(userId, opts = {}) {
  const {
    color = '#8b5cf6',
    settings: settingsOverride = {},
    privacyPreset = 'balanced',
    starterSession = null,
  } = opts;
  const paths = userPaths(userId);
  if (!migrateLegacyIntoUser(userId)) {
    write(paths.settings, {
      ...DEFAULT_SETTINGS,
      restoreSession: false,
      ...privacyPresetSettings(privacyPreset),
      ...settingsOverride,
    });
    write(paths.history, []);
    write(paths.bookmarks, []);
    write(privacyPath(userId), privacyPresetDoc(privacyPreset));

    const session = emptySessionSeed(color);
    if (starterSession && starterSession.id && starterSession.id !== 'custom') {
      const sid = `s_${Date.now()}`;
      session.profiles.push({
        id: sid,
        name: starterSession.name || starterSession.id,
        color: starterSession.color || color,
        isIncognito: true,
        ephemeral: !!starterSession.ephemeral,
        partition: null,
        templateId: starterSession.id,
        privacy: starterSession.defaults || {},
        searchEngine: starterSession.defaults?.searchEngine || settingsOverride.searchEngine || DEFAULT_SETTINGS.searchEngine,
      });
    }
    write(paths.session, session);
    try { fs.writeFileSync(paths.notes, ''); } catch { /* ignore */ }
  } else if (!fs.existsSync(paths.settings)) {
    write(paths.settings, { ...DEFAULT_SETTINGS, restoreSession: false, ...settingsOverride });
  }
}

function migrateLegacyIntoUser(userId) {
  const paths = userPaths(userId);
  let copied = false;
  for (const [key, legacy] of Object.entries(LEGACY_PATHS)) {
    const dest = paths[key];
    if (fs.existsSync(legacy) && !fs.existsSync(dest)) {
      try { fs.copyFileSync(legacy, dest); copied = true; } catch (e) { console.error('[migrate]', key, e); }
    }
  }
  return copied;
}

function ensureUsersMigrated() {
  fs.mkdirSync(USERS_ROOT, { recursive: true });
  if (fs.existsSync(REGISTRY_PATH)) return;

  const hasLegacy = Object.values(LEGACY_PATHS).some(p => fs.existsSync(p));
  if (!hasLegacy) return;

  const userId = 'u_default';
  userDir(userId);
  seedUserFiles(userId, { name: 'You', color: '#8b5cf6', type: 'account' });
  write(REGISTRY_PATH, {
    activeUserId: userId,
    onboardingComplete: true,
    users: [{ id: userId, name: 'You', color: '#8b5cf6', type: 'account', created: Date.now() }],
  });
}

function getRegistry() {
  fs.mkdirSync(USERS_ROOT, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { activeUserId: null, users: [], onboardingComplete: false };
  }
  const reg = read(REGISTRY_PATH, { activeUserId: null, users: [], onboardingComplete: false });
  if (!reg.onboardingComplete && reg.users?.length) {
    reg.onboardingComplete = true;
    saveRegistry(reg);
  }
  return reg;
}

function saveRegistry(reg) {
  write(REGISTRY_PATH, reg);
}

function setActiveUser(userId) {
  if (!userId) return;
  activeUserId = userId;
  appSettings = getSettings();
  applySessionPolicy(session.fromPartition(mainPartition(userId)));
}
function loadAppIcon() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'icons', 'icon.ico'),
      path.join(process.resourcesPath, 'icons', 'icon.png'),
      path.join(process.resourcesPath, 'icons', 'icon_256.png'),
      path.join(process.resourcesPath, 'icons', 'icon_128.png'),
    );
  }
  candidates.push(
    path.join(__dirname, '../assets/icons/icon.ico'),
    path.join(__dirname, '../assets/icons/icon.png'),
    path.join(__dirname, '../assets/icons/icon_256.png'),
    path.join(__dirname, '../assets/icons/icon_128.png'),
  );
  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img;
    } catch {}
  }
  return nativeImage.createEmpty();
}

const APP_ICON = loadAppIcon();

const DEFAULT_SETTINGS = {
  homepage: 'https://google.com',
  searchEngine: 'google',
  theme: 'dark',
  showClock: true,
  compactTabs: false,
  blockTrackers: true,
  httpsOnly: false,
  doNotTrack: true,
  blockPopups: true,
  restoreSession: false,
  filterLists: true,
  fingerprintProtection: true,
  webrtcProtection: true,
  mixedContentBlock: false,
  checkUpdates: true,
  autoInstallUpdates: false,
};

const sessionConfigs = new Map();
const sessionBlockedCounts = new Map();

function sessionKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

function privacyPath(userId = activeUserId) {
  return path.join(userDir(userId), 'privacy.json');
}

function getPrivacyDoc(userId = activeUserId) {
  return { ...DEFAULT_PRIVACY, ...read(privacyPath(userId), {}) };
}

function savePrivacyDoc(doc, userId = activeUserId) {
  write(privacyPath(userId), { ...DEFAULT_PRIVACY, ...doc });
}

function getSessionConfig(userId, sessionId) {
  return sessionConfigs.get(sessionKey(userId, sessionId)) || {};
}

function parseProxy(proxyStr) {
  if (!proxyStr || !String(proxyStr).trim()) return null;
  const s = String(proxyStr).trim();
  if (s === 'direct') return { mode: 'direct' };
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    const scheme = u.protocol.replace(':', '');
    if (scheme === 'socks5' || scheme === 'socks4') {
      return { proxyRules: `${scheme}=${u.hostname}:${u.port || 1080}` };
    }
    const port = u.port || (scheme === 'https' ? 443 : 80);
    return { proxyRules: `http=${u.hostname}:${port};https=${u.hostname}:${port}` };
  } catch {
    return { proxyRules: s };
  }
}

async function applyProxy(ses, proxyStr) {
  const cfg = parseProxy(proxyStr);
  if (cfg) await ses.setProxy(cfg);
}

const read  = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const write = (p, d)  => { try { fs.writeFileSync(p, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let mainWin = null;
let splashWin = null;
const downloads = [];
const downloadItems = new Map();
const hookedSessions = new WeakSet();
let appSettings = { ...DEFAULT_SETTINGS };
let blockedTrackerCount = 0;

function getSettings(userId = activeUserId) {
  if (!userId) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...read(userPaths(userId).settings, {}) };
}

function permissionLabel(permission) {
  return ({
    geolocation: 'use your location',
    media: 'use your camera and/or microphone',
    notifications: 'send notifications',
  })[permission] || permission;
}

function permissionHost(url) {
  try { return new URL(url).hostname; } catch { return url || 'This site'; }
}

function promptPermission(permission, url) {
  if (!mainWin) return false;
  const site = permissionHost(url);
  const { response } = dialog.showMessageBoxSync(mainWin, {
    type: 'question',
    buttons: ['Allow', 'Block'],
    defaultId: 0,
    cancelId: 1,
    title: 'Permission request',
    message: `${site} wants to ${permissionLabel(permission)}`,
    detail: url ? `Origin: ${url}` : '',
    noLink: true,
  });
  return response === 0;
}

function notifyPermissionBlocked(permission, url) {
  mainWin?.webContents.send('permission-blocked', { permission, url });
}

function hookDownloads(ses) {
  if (hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  ses.on('will-download', (_, item) => {
    const savePath = path.join(os.homedir(), 'Downloads', item.getFilename());
    item.setSavePath(savePath);
    const dl = {
      id: Date.now(),
      filename: item.getFilename(),
      url: item.getURL(),
      path: savePath,
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      paused: false,
    };
    downloadItems.set(dl.id, item);
    downloads.unshift(dl);
    mainWin?.webContents.send('dl-start', dl);
    item.on('updated', (_, st) => {
      dl.state = st;
      dl.received = item.getReceivedBytes();
      dl.total = item.getTotalBytes();
      dl.paused = item.isPaused();
      mainWin?.webContents.send('dl-update', {
        id: dl.id, state: st, received: dl.received, total: dl.total, paused: dl.paused,
      });
    });
    item.once('done', (_, st) => {
      dl.state = st;
      dl.paused = false;
      downloadItems.delete(dl.id);
      mainWin?.webContents.send('dl-done', { id: dl.id, state: st, path: savePath });
    });
  });
}

function syncNativeTheme(_theme) {
  // Enigma chrome theme is CSS-only — never propagate to Chromium / web pages.
  nativeTheme.themeSource = 'light';
}

/** Read OS dark preference without leaving web content on system/dark scheme. */
function readOsPrefersDark() {
  const prev = nativeTheme.themeSource;
  nativeTheme.themeSource = 'system';
  const dark = nativeTheme.shouldUseDarkColors;
  nativeTheme.themeSource = 'light';
  return dark;
}

const webContentsLightHooked = new WeakSet();

/** Keep guest pages on light color scheme — runs before any page script. */
async function forceLightColorScheme(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    if (!webContentsLightHooked.has(webContents)) {
      webContentsLightHooked.add(webContents);
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: FORCE_LIGHT_PAGE,
      });
    }
  } catch {}
}

function hookWebviewColorScheme() {
  if (!mainWin) return;
  mainWin.webContents.on('did-attach-webview', (_, contents) => {
    const apply = () => { void forceLightColorScheme(contents); };
    contents.on('did-start-loading', apply);
    contents.on('did-finish-load', apply);
    contents.on('did-navigate', apply);
    contents.on('did-navigate-in-page', apply);
    apply();
  });
}

let osThemeWatchTimer = null;
function syncOsThemeWatcher(theme) {
  if (osThemeWatchTimer) {
    clearInterval(osThemeWatchTimer);
    osThemeWatchTimer = null;
  }
  if (theme !== 'system') return;
  let last = readOsPrefersDark();
  osThemeWatchTimer = setInterval(() => {
    if (getSettings().theme !== 'system') return;
    const dark = readOsPrefersDark();
    if (dark !== last) {
      last = dark;
      mainWin?.webContents.send('os-theme-changed', dark);
    }
  }, 1500);
}

function buildEffectiveSettings(sessionId = null) {
  const global = getSettings();
  const privacy = getPrivacyDoc();
  const sessCfg = sessionId ? getSessionConfig(activeUserId, sessionId) : {};
  return effectiveSettings(global, privacy, sessCfg.privacy || {});
}

function applySessionPolicy(ses, sessionId = null, ephemeral = false) {
  const onBlocked = () => {
    blockedTrackerCount++;
    if (sessionId) {
      const key = sessionKey(activeUserId, sessionId);
      sessionBlockedCounts.set(key, (sessionBlockedCounts.get(key) || 0) + 1);
      mainWin?.webContents.send('session-blocked', {
        sessionId,
        count: sessionBlockedCounts.get(key),
      });
    }
    mainWin?.webContents.send('tracker-blocked', blockedTrackerCount);
  };
  hardenSession(
    ses,
    () => buildEffectiveSettings(sessionId),
    notifyPermissionBlocked,
    onBlocked,
    promptPermission,
  );
  hookDownloads(ses);
  if (sessionId) {
    const cfg = getSessionConfig(activeUserId, sessionId);
    if (cfg.proxy) void applyProxy(ses, cfg.proxy);
  }
}

function createSplash() {
  splashWin = new BrowserWindow({
    width: 440, height: 280, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, center: true, skipTaskbar: true,
    icon: APP_ICON,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  splashWin.loadFile(path.join(__dirname, '../assets/splash.html'));
}

function createMain() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(920, height),
    minWidth: 900, minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0d0b18',
    icon: APP_ICON,
    title: 'Enigma',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hookWebviewColorScheme();
  if (process.platform === 'win32' && !APP_ICON.isEmpty()) mainWin.setIcon(APP_ICON);
  mainWin.loadFile(path.join(__dirname, '../assets/index.html'));

  mainWin.once('ready-to-show', () => {
    setTimeout(() => {
      splashWin?.destroy();
      splashWin = null;
      mainWin.show();
      mainWin.focus();
    }, 1400);
  });

  mainWin.webContents.on('before-input-event', (e, k) => {
    const c = k.control || k.meta;
    if (!c) return;
    const MAP = {
      t: 'new-tab', w: 'close-tab', r: 'reload', l: 'focus-url',
      f: 'find', b: 'bookmarks', h: 'history', d: 'bookmark',
      '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset',
      '[': 'back', ']': 'fwd', p: 'print',
    };
    const cmd = MAP[k.key.toLowerCase()];
    if (cmd) { mainWin.webContents.send('cmd', cmd); e.preventDefault(); return; }
    if (c && k.shift && k.key.toLowerCase() === 't') {
      mainWin.webContents.send('cmd', 'reopen-tab');
      e.preventDefault();
    }
    if (c && k.shift && k.key.toLowerCase() === 'n') {
      mainWin.webContents.send('cmd', 'new-incognito');
      e.preventDefault();
    }
    if (c && k.shift && k.key.toLowerCase() === 'i') {
      mainWin.webContents.send('cmd', 'devtools');
      e.preventDefault();
    }
    if (c && k.shift && k.key.toLowerCase() === 'r') {
      mainWin.webContents.send('cmd', 'hard-reload');
      e.preventDefault();
    }
    if (c && k.shift && k.key.toLowerCase() === 'c') {
      mainWin.webContents.send('cmd', 'copy-url');
      e.preventDefault();
    }
    if (!c && !k.shift && !k.alt && k.key === 'F11') {
      mainWin.webContents.send('cmd', 'fullscreen');
      e.preventDefault();
    }
  });

  mainWin.on('maximize', () => mainWin.webContents.send('win-state', 'maximized'));
  mainWin.on('unmaximize', () => mainWin.webContents.send('win-state', 'normal'));
  mainWin.on('closed', () => { mainWin = null; });

  initUpdater(() => mainWin, {
    hasActiveDownloads: () => downloads.some(d => d.state === 'progressing'),
    shouldCheckUpdates: () => getSettings().checkUpdates !== false,
  });
  ensureUsersMigrated();
  const reg = getRegistry();
  if (reg.activeUserId) setActiveUser(reg.activeUserId);
}

// ── IPC: window chrome ────────────────────────────────────────────────────────
ipcMain.handle('win-min', () => mainWin?.minimize());
ipcMain.handle('win-max', () => (mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize()));
ipcMain.handle('win-close', () => mainWin?.close());
ipcMain.handle('win-is-max', () => mainWin?.isMaximized() ?? false);
ipcMain.handle('open-devtools', () => mainWin?.webContents.openDevTools({ mode: 'detach' }));

// ── IPC: users ────────────────────────────────────────────────────────────────
ipcMain.handle('users-init', () => {
  ensureUsersMigrated();
  const reg = getRegistry();
  if (reg.onboardingComplete && reg.activeUserId) setActiveUser(reg.activeUserId);
  return {
    ...reg,
    needsOnboarding: !reg.onboardingComplete,
    appVersion: app.getVersion(),
  };
});

ipcMain.handle('onboarding-complete', (_, { mode, name, color }) => {
  const reg = getRegistry();
  if (reg.onboardingComplete) {
    return { ...reg, needsOnboarding: false, appVersion: app.getVersion() };
  }
  const id = `u_${Date.now()}`;
  const displayName = (name || '').trim() || (mode === 'guest' ? 'Guest' : 'User');
  const accent = color || '#8b5cf6';
  userDir(id);
  seedUserFiles(id, { name: displayName, color: accent, type: mode === 'guest' ? 'guest' : 'account' });
  const next = {
    activeUserId: id,
    onboardingComplete: true,
    users: [{
      id,
      name: displayName,
      color: accent,
      type: mode === 'guest' ? 'guest' : 'account',
      created: Date.now(),
    }],
  };
  saveRegistry(next);
  setActiveUser(id);
  return { ...next, needsOnboarding: false, appVersion: app.getVersion() };
});

ipcMain.handle('users-switch', (_, userId) => {
  const reg = getRegistry();
  if (!reg.users.some(u => u.id === userId)) return null;
  reg.activeUserId = userId;
  saveRegistry(reg);
  setActiveUser(userId);
  return { activeUserId: userId, users: reg.users };
});

ipcMain.handle('users-create', (_, payload = {}) => {
  const reg = getRegistry();
  const id = `u_${Date.now()}`;
  const name = (payload.name || '').trim() || 'User';
  const color = payload.color || '#8b5cf6';
  const avatar = (payload.avatar || '').trim().slice(0, 4) || '';
  const theme = payload.theme || DEFAULT_SETTINGS.theme;
  const searchEngine = payload.searchEngine || DEFAULT_SETTINGS.searchEngine;
  const homepage = (payload.homepage || '').trim() || DEFAULT_SETTINGS.homepage;
  const privacyPreset = ['strict', 'relaxed', 'balanced'].includes(payload.privacyPreset)
    ? payload.privacyPreset
    : 'balanced';
  const starterSession = payload.starterSession && typeof payload.starterSession === 'object'
    ? payload.starterSession
    : null;

  reg.users.push({
    id,
    name,
    color,
    avatar,
    type: 'account',
    created: Date.now(),
  });
  reg.activeUserId = id;
  reg.onboardingComplete = true;
  saveRegistry(reg);
  userDir(id);
  seedUserFiles(id, {
    name,
    color,
    type: 'account',
    privacyPreset,
    starterSession,
    settings: {
      theme,
      searchEngine,
      homepage,
      showClock: payload.showClock !== false,
      compactTabs: !!payload.compactTabs,
      restoreSession: !!payload.restoreSession,
      checkUpdates: payload.checkUpdates !== false,
    },
  });
  setActiveUser(id);
  return { id, name, color, avatar, users: reg.users };
});

ipcMain.handle('users-remove', async (_, userId) => {
  const reg = getRegistry();
  if (reg.users.length <= 1 || !reg.users.some(u => u.id === userId)) return null;
  reg.users = reg.users.filter(u => u.id !== userId);
  if (reg.activeUserId === userId) reg.activeUserId = reg.users[0].id;
  saveRegistry(reg);
  setActiveUser(reg.activeUserId);
  try {
    const dir = path.join(USERS_ROOT, userId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { console.error('[users-remove]', e); }
  return reg;
});

ipcMain.handle('user-main-partition', () => mainPartition());

// ── IPC: sessions (scoped to active user) ─────────────────────────────────────
ipcMain.handle('session-register', async (_, id, config) => {
  const cfg = config || {};
  sessionConfigs.set(sessionKey(activeUserId, id), cfg);
  const ephemeral = !!cfg.ephemeral;
  const ses = session.fromPartition(sessionPartition(activeUserId, id, ephemeral));
  applySessionPolicy(ses, id, ephemeral);
  if (cfg.proxy) await applyProxy(ses, cfg.proxy);
  return true;
});

ipcMain.handle('session-create', async (_, id, config) => {
  const cfg = typeof config === 'boolean' ? { ephemeral: config } : (config || {});
  const ephemeral = !!cfg.ephemeral;
  sessionConfigs.set(sessionKey(activeUserId, id), cfg);
  const partition = sessionPartition(activeUserId, id, ephemeral);
  const ses = session.fromPartition(partition);
  applySessionPolicy(ses, id, ephemeral);
  if (cfg.proxy) await applyProxy(ses, cfg.proxy);
  return partition;
});

ipcMain.handle('session-clear', async (_, id, ephemeral) => {
  try {
    const ses = session.fromPartition(sessionPartition(activeUserId, id, ephemeral));
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  } catch {}
  return true;
});

ipcMain.handle('session-burn', async (_, id, ephemeral) => {
  const key = sessionKey(activeUserId, id);
  try {
    const ses = session.fromPartition(sessionPartition(activeUserId, id, ephemeral));
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    await ses.clearCodeCaches?.();
  } catch {}
  sessionBlockedCounts.set(key, 0);
  blockedTrackerCount = 0;
  return true;
});

ipcMain.handle('session-stats', async (_, id, ephemeral) => {
  const ses = session.fromPartition(sessionPartition(activeUserId, id, ephemeral));
  let cookies = [];
  let cacheBytes = 0;
  try { cookies = await ses.cookies.get({}); } catch {}
  try { cacheBytes = await ses.getCacheSize(); } catch {}
  const origins = [...new Set(cookies.map(c => String(c.domain || '').replace(/^\./, '')))].filter(Boolean).slice(0, 40);
  const key = sessionKey(activeUserId, id);
  return {
    cookies: cookies.length,
    origins,
    cacheBytes,
    blocked: sessionBlockedCounts.get(key) || 0,
    filterRules: sharedEngine.domainRules.size,
  };
});

ipcMain.handle('session-blocked-count', (_, id) => sessionBlockedCounts.get(sessionKey(activeUserId, id)) || 0);

ipcMain.handle('session-templates', () => listTemplates());

ipcMain.handle('fingerprint-script', () => FINGERPRINT_INJECT);

ipcMain.handle('session-apply-settings', () => {
  appSettings = getSettings();
  applySessionPolicy(session.fromPartition(mainPartition()));
  for (const [key, cfg] of sessionConfigs.entries()) {
    if (!key.startsWith(`${activeUserId}:`)) continue;
    const sessionId = key.slice(activeUserId.length + 1);
    const ses = session.fromPartition(sessionPartition(activeUserId, sessionId, !!cfg.ephemeral));
    applySessionPolicy(ses, sessionId, !!cfg.ephemeral);
  }
  return true;
});

ipcMain.handle('privacy-load', () => getPrivacyDoc());
ipcMain.handle('privacy-save', (_, doc) => { savePrivacyDoc(doc); return true; });
ipcMain.handle('site-exception-set', (_, host, action) => {
  const doc = getPrivacyDoc();
  const h = String(host || '').toLowerCase().replace(/^\./, '');
  if (!h) return doc;
  if (!action) delete doc.siteExceptions[h];
  else doc.siteExceptions[h] = action;
  savePrivacyDoc(doc);
  return doc;
});

ipcMain.handle('sync-export', (_, passphrase) => {
  if (!passphrase || String(passphrase).length < 8) throw new Error('Passphrase must be at least 8 characters');
  return encryptVault(passphrase, {
    bookmarks: read(userPaths().bookmarks, []),
    settings: getSettings(),
    privacy: getPrivacyDoc(),
    sessions: read(userPaths().session, null),
  });
});

ipcMain.handle('sync-import', (_, passphrase, vault) => {
  const data = decryptVault(passphrase, vault);
  if (data.bookmarks) write(userPaths().bookmarks, data.bookmarks);
  if (data.settings) {
    appSettings = { ...DEFAULT_SETTINGS, ...data.settings };
    write(userPaths().settings, appSettings);
  }
  if (data.privacy) savePrivacyDoc(data.privacy);
  if (data.sessions) write(userPaths().session, data.sessions);
  return data;
});

ipcMain.handle('sync-export-file', async (_, passphrase) => {
  const vault = encryptVault(passphrase, {
    bookmarks: read(userPaths().bookmarks, []),
    settings: getSettings(),
    privacy: getPrivacyDoc(),
    sessions: read(userPaths().session, null),
  });
  const r = await dialog.showSaveDialog(mainWin, {
    title: 'Export encrypted vault',
    defaultPath: 'enigma-vault.json',
    filters: [{ name: 'Enigma Vault', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(vault, null, 2));
  return r.filePath;
});

ipcMain.handle('sync-import-file', async (_, passphrase) => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Import encrypted vault',
    filters: [{ name: 'Enigma Vault', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  const vault = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  const data = decryptVault(passphrase, vault);
  if (data.bookmarks) write(userPaths().bookmarks, data.bookmarks);
  if (data.settings) {
    appSettings = { ...DEFAULT_SETTINGS, ...data.settings };
    write(userPaths().settings, appSettings);
  }
  if (data.privacy) savePrivacyDoc(data.privacy);
  if (data.sessions) write(userPaths().session, data.sessions);
  return data;
});

ipcMain.handle('validate-url', (_, url) => isNavigableUrl(url));

// ── IPC: data (scoped to active user) ─────────────────────────────────────────
ipcMain.handle('history-load', () => {
  const p = userPaths().history;
  const h = read(p, []);
  const seen = new Set();
  const compact = [];
  for (const item of h) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    compact.push(item);
  }
  if (compact.length !== h.length) write(p, compact);
  return compact;
});
ipcMain.handle('history-add', (_, e) => {
  const url = e?.url;
  if (!url || url.startsWith('about:')) return;
  const p = userPaths().history;
  const h = read(p, []);
  const filtered = h.filter(x => x.url !== url);
  filtered.unshift({ ...e, ts: Date.now() });
  write(p, filtered.slice(0, 8000));
});
ipcMain.handle('history-clear', () => write(userPaths().history, []));
ipcMain.handle('history-delete', (_, url) => {
  const p = userPaths().history;
  write(p, read(p, []).filter(h => h.url !== url));
});
ipcMain.handle('bm-load', () => read(userPaths().bookmarks, []));
ipcMain.handle('bm-save', (_, d) => write(userPaths().bookmarks, d));
ipcMain.handle('settings-load', () => getSettings());
ipcMain.handle('settings-save', (_, d) => {
  appSettings = { ...DEFAULT_SETTINGS, ...d };
  write(userPaths().settings, appSettings);
  syncNativeTheme(appSettings.theme);
  syncOsThemeWatcher(appSettings.theme);
  return true;
});
ipcMain.handle('os-prefers-dark', () => readOsPrefersDark());
ipcMain.handle('dl-list', () => downloads);
ipcMain.handle('dl-pause', (_, id) => {
  const item = downloadItems.get(id);
  if (!item || item.isPaused()) return false;
  item.pause();
  return true;
});
ipcMain.handle('dl-resume', (_, id) => {
  const item = downloadItems.get(id);
  if (!item || !item.canResume()) return false;
  item.resume();
  return true;
});
ipcMain.handle('dl-cancel', (_, id) => {
  const item = downloadItems.get(id);
  if (!item) return false;
  item.cancel();
  return true;
});
ipcMain.handle('dl-remove', (_, id) => {
  const idx = downloads.findIndex(d => d.id === id);
  if (idx >= 0) downloads.splice(idx, 1);
  downloadItems.delete(id);
  return true;
});
ipcMain.handle('session-save', (_, d) => { write(userPaths().session, d); return true; });
ipcMain.handle('session-load', () => read(userPaths().session, null));
ipcMain.handle('notes-load', () => {
  try { return fs.readFileSync(userPaths().notes, 'utf8'); } catch { return ''; }
});
ipcMain.handle('notes-save', (_, text) => {
  try { fs.writeFileSync(userPaths().notes, text || ''); } catch (e) { console.error(e); }
  return true;
});
ipcMain.handle('blocked-count', () => blockedTrackerCount);
ipcMain.handle('blocked-reset', () => { blockedTrackerCount = 0; return 0; });
ipcMain.handle('clear-browsing-data', async () => {
  const ses = session.fromPartition(mainPartition());
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});
ipcMain.handle('export-bookmarks', async (_, data) => {
  const r = await dialog.showSaveDialog(mainWin, {
    title: 'Export bookmarks',
    defaultPath: 'enigma-bookmarks.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
});
ipcMain.handle('import-bookmarks', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Import bookmarks',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch { return null; }
});
ipcMain.handle('save-screenshot', (_, bytes) => {
  const p = path.join(os.homedir(), 'Downloads', `Enigma-${Date.now()}.png`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

// ── IPC: misc ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-file', (_, p) => shell.openPath(p));
ipcMain.handle('open-external', (_, u) => {
  if (!isSafeExternalUrl(u)) return false;
  shell.openExternal(u);
  return true;
});
ipcMain.handle('clipboard', (_, t) => clipboard.writeText(t));
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('app-icon-url', () => {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'icons', 'icon_256.png'),
      path.join(process.resourcesPath, 'icons', 'icon_128.png'),
      path.join(process.resourcesPath, 'icons', 'icon.png'),
      path.join(process.resourcesPath, 'icons', 'icon.ico'),
    );
  }
  candidates.push(
    path.join(__dirname, '../assets/icons/icon_256.png'),
    path.join(__dirname, '../assets/icons/icon_128.png'),
    path.join(__dirname, '../assets/icons/icon.png'),
  );
  for (const iconPath of candidates) {
    if (fs.existsSync(iconPath)) {
      return `file://${iconPath.replace(/\\/g, '/')}`;
    }
  }
  return null;
});
ipcMain.handle('chromium-version', () => process.versions.chrome);
ipcMain.handle('electron-version', () => process.versions.electron);

ipcMain.handle('check-for-update', () => checkForUpdates());
ipcMain.handle('download-update', () => downloadUpdate());
ipcMain.handle('install-update', (_, opts) => installUpdate(opts || {}));
ipcMain.handle('quit-and-install', () => quitAndInstall());
ipcMain.handle('update-status', () => getUpdateStatus());
ipcMain.handle('has-active-downloads', () => downloads.some(d => d.state === 'progressing'));

ipcMain.handle('context-menu', (_, p) => {
  const items = [];
  if (p.selectionText?.trim()) {
    items.push(
      { label: `Search "${p.selectionText.slice(0, 30)}"`, click: () => mainWin.webContents.send('cmd', `search-selection:${p.selectionText}`) },
      { label: 'Copy', role: 'copy' },
      { type: 'separator' },
    );
  }
  if (p.linkURL) {
    items.push(
      { label: 'Open in new tab', click: () => mainWin.webContents.send('open-link', p.linkURL) },
      { label: 'Open in incognito', click: () => mainWin.webContents.send('open-link-incog', p.linkURL) },
      { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
  }
  if (p.mediaType === 'image') {
    items.push(
      { label: 'Open image in new tab', click: () => mainWin.webContents.send('open-link', p.srcURL) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      { type: 'separator' },
    );
  }
  items.push(
    { label: 'Back', enabled: p.canBack, click: () => mainWin.webContents.send('cmd', 'back') },
    { label: 'Forward', enabled: p.canFwd, click: () => mainWin.webContents.send('cmd', 'fwd') },
    { label: 'Reload', click: () => mainWin.webContents.send('cmd', 'reload') },
    { type: 'separator' },
    { label: 'Print…', click: () => mainWin.webContents.send('cmd', 'print') },
    { type: 'separator' },
    { label: 'View page source', click: () => mainWin.webContents.send('cmd', 'view-source') },
    { label: 'Inspect', click: () => mainWin.webContents.send('cmd', 'devtools') },
  );
  Menu.buildFromTemplate(items).popup({ window: mainWin });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  app.whenReady().then(() => {
    ensureMachineBinding();
    ensureUsersMigrated();
    const reg = getRegistry();
    if (reg.activeUserId) setActiveUser(reg.activeUserId);
    syncNativeTheme(appSettings.theme);
    syncOsThemeWatcher(appSettings.theme);
    createSplash();
    createMain();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!mainWin) createMain(); });
}
