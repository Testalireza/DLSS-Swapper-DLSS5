'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * GOG detector — best effort.
 *
 * Primary source on Windows: the registry keys GOG Galaxy writes under
 * HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<gameId> (values: path, exePath).
 * Fallback: scanning the default C:\GOG Games folder.
 *
 * `opts.regOutput` injects fake `reg query` output for tests; `opts.roots`
 * injects fallback scan roots.
 */

function parseRegQueryGames(stdout) {
  // reg query /s output: key headers at column 0, values indented.
  const games = [];
  let current = null;
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (/^HKEY_/i.test(line.trim())) {
      if (current && current.path) games.push(current);
      current = { key: line.trim() };
      continue;
    }
    if (!current) continue;
    const m = line.trim().match(/^(\S+)\s+REG_(SZ|EXPAND_SZ|DWORD)\s+(.+)$/i);
    if (!m) continue;
    const [, name, , value] = m;
    if (/^path$/i.test(name)) current.path = value.trim();
    else if (/^exePath$/i.test(name)) current.exePath = value.trim();
    else if (/^gameID$/i.test(name)) current.gameId = value.trim();
    else if (/^workingDir$/i.test(name)) current.workingDir = value.trim();
  }
  if (current && current.path) games.push(current);
  return games;
}

async function detect(env, opts = {}) {
  const logger = opts.logger;
  const games = [];
  const seen = new Set();

  if (env.isWindows || opts.regOutput) {
    let stdout = opts.regOutput;
    if (stdout === undefined) {
      try {
        const res = await env.runner('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s'], { timeout: 8000 });
        stdout = res.stdout;
      } catch {
        try {
          const res = await env.runner('reg', ['query', 'HKLM\\SOFTWARE\\GOG.com\\Games', '/s'], { timeout: 8000 });
          stdout = res.stdout;
        } catch {
          stdout = '';
        }
      }
    }
    for (const g of parseRegQueryGames(stdout)) {
      if (!g.path || !fs.existsSync(g.path)) continue;
      const key = path.resolve(g.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      games.push({
        id: `gog-${g.gameId || path.basename(g.path).toLowerCase()}`,
        name: path.basename(g.path),
        provider: 'gog',
        installDir: g.path,
        exeName: g.exePath ? path.basename(g.exePath) : null,
        exePath: g.exePath && fs.existsSync(g.exePath) ? g.exePath : null,
      });
    }
  }

  // Fallback: scan the default GOG folder for game directories.
  const roots = opts.roots || (env.isWindows ? ['C:\\GOG Games'] : []);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      games.push({ id: `gog-${e.name.toLowerCase()}`, name: e.name, provider: 'gog', installDir: dir, exeName: null });
    }
  }

  if (logger) await logger.debug(`GOG detection finished: ${games.length} game(s)`);
  return games;
}

module.exports = { detect, parseRegQueryGames };
