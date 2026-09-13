'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Custom-folder detector.
 *
 * Walks user-configured folders (Options → Game scanning → Custom game
 * folders) up to a bounded depth and reports directories that look like game
 * installs: they directly contain an executable (*.exe) or an NVIDIA runtime
 * file (nvngx*.dll).
 *
 * This also makes the app fully usable on machines where games live in
 * non-standard places, and powers the browser dev-preview.
 */

const SKIP_DIRS = new Set([
  'node_modules', '__redist', '_commonredist', '_installer', 'redist', 'directx',
  'vcredist', '$recycle.bin', 'system volume information', '.git', 'saves',
  '__overlay', 'easyanticheat', 'battleye',
]);

/**
 * Folder names that are really a sub-location of the game (Unreal-style
 * "Binaries/Win64", "bin/x64", ...). When the executable lives in one of
 * these, the parent folder is reported as the game install instead, which is
 * what users recognise as "the game".
 */
const BIN_LIKE_DIRS = new Set(['binaries', 'bin', 'win64', 'win32', 'x64', 'x86', 'windows']);

function normalizeGameDir(dir) {
  let current = dir;
  for (let i = 0; i < 3; i++) {
    const base = path.basename(current).toLowerCase();
    if (BIN_LIKE_DIRS.has(base)) current = path.dirname(current);
    else break;
  }
  return current;
}

function looksLikeGame(fileNames) {
  let hasExe = false;
  let hasNvngx = false;
  for (const n of fileNames) {
    const lower = n.toLowerCase();
    if (lower.endsWith('.exe')) hasExe = true;
    else if (lower.startsWith('nvngx') && lower.endsWith('.dll')) hasNvngx = true;
  }
  return hasExe || hasNvngx;
}

async function walk(root, depth, maxDepth, found, guard) {
  if (depth > maxDepth || guard.count > 20000) return;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  guard.count += entries.length;
  const fileNames = [];
  const subDirs = [];
  for (const e of entries) {
    if (e.isFile()) fileNames.push(e.name);
    else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) {
      subDirs.push(path.join(root, e.name));
    }
  }
  if (looksLikeGame(fileNames)) {
    found.push(root);
    // Do not descend into a folder we already classify as a game install.
    return;
  }
  for (const d of subDirs) {
    await walk(d, depth + 1, maxDepth, found, guard);
  }
}

async function detect(env, opts = {}) {
  const settings = opts.settings || {};
  const folders = opts.folders || settings.customGameFolders || [];
  const maxDepth = opts.depth ?? settings.scanDepth ?? 3;
  const games = [];
  const seen = new Set();
  for (const folder of folders) {
    const root = env.expandEnvVars(folder);
    if (!root || !fs.existsSync(root)) continue;
    const found = [];
    await walk(root, 0, maxDepth, found, { count: 0 });
    for (const dir of found.map(normalizeGameDir)) {
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const idHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
      games.push({
        id: `folder-${idHash}`,
        name: path.basename(dir),
        provider: 'folder',
        installDir: dir,
        exeName: null,
      });
    }
  }
  return games;
}

module.exports = { detect, looksLikeGame };
