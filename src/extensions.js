const fs = require('fs');
const path = require('path');

function extensionsFile(userDirFn, userId) {
  return path.join(userDirFn(userId), 'extensions.json');
}

function loadExtensions(read, userDirFn, userId) {
  const doc = read(extensionsFile(userDirFn, userId), { items: [] });
  doc.items = Array.isArray(doc.items) ? doc.items : [];
  return doc;
}

function saveExtensions(write, userDirFn, userId, doc) {
  write(extensionsFile(userDirFn, userId), doc);
}

function readManifest(extPath) {
  const manifestPath = path.join(extPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function applyExtensionsToSession(ses, items) {
  const loaded = [];
  if (!ses || ses.isDestroyed?.()) return loaded;
  for (const item of items) {
    if (item.enabled === false || !item.path || !fs.existsSync(item.path)) continue;
    if (!readManifest(item.path)) continue;
    try {
      const info = await ses.loadExtension(item.path, { allowFileAccess: true });
      loaded.push({ storeId: item.id, runtimeId: info.id, name: info.name || item.name });
    } catch (e) {
      console.error('[extensions] load failed', item.path, e.message);
    }
  }
  return loaded;
}

async function removeExtensionsFromSession(ses) {
  if (!ses || ses.isDestroyed?.()) return;
  try {
    const existing = ses.getAllExtensions?.() || {};
    for (const ext of Object.values(existing)) {
      try { ses.removeExtension(ext.id); } catch {}
    }
  } catch {}
}

module.exports = {
  loadExtensions,
  saveExtensions,
  readManifest,
  applyExtensionsToSession,
  removeExtensionsFromSession,
};
