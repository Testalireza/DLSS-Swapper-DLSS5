'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { parseVdf, extractSteamLibraries, extractAppInfo } = require('../vdf');

/**
 * Steam detector.
 *
 * Finds Steam installs (registry on Windows, well-known paths elsewhere),
 * parses libraryfolders.vdf for all library locations, then reads every
 * appmanifest_*.acf to enumerate installed games.
 *
 * `opts.roots` overrides root discovery — used by tests with fixture trees.
 */

async function findSteamRoots(env) {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  if (env.isWindows) {
    // Registry (HKCU) is authoritative for the running user.
    try {
      const { stdout } = await env.runner('reg', [
        'query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath',
      ], { timeout: 5000 });
      const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) push(m[1].trim().replace(/\//g, '\\'));
    } catch { /* not installed for this user */ }
    push(env.expandEnvVars('%ProgramFiles(x86)%\\Steam'));
    push(env.expandEnvVars('%ProgramFiles%\\Steam'));
    push(`C:\\Steam`);
  } else if (env.platform === 'darwin') {
    push(path.join(env.homeDir, 'Library', 'Application Support', 'Steam'));
  } else {
    push(path.join(env.homeDir, '.steam', 'steam'));
    push(path.join(env.homeDir, '.local', 'share', 'Steam'));
    push(path.join(env.homeDir, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'));
    push(path.join(env.homeDir, '.steam', 'debian-installation'));
  }
  return roots.filter((r) => fs.existsSync(path.join(r, 'steamapps')));
}

async function detect(env, opts = {}) {
  const logger = opts.logger;
  const roots = opts.roots || (await findSteamRoots(env));
  const games = [];
  for (const root of roots) {
    // Library list: the root itself + everything in libraryfolders.vdf.
    const libraries = [root];
    try {
      const vdfText = await fsp.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const lib of extractSteamLibraries(parseVdf(vdfText))) {
        const resolved = env.isWindows ? lib.replace(/\//g, '\\') : lib;
        if (!libraries.some((l) => path.resolve(l).toLowerCase() === path.resolve(resolved).toLowerCase())) {
          libraries.push(resolved);
        }
      }
    } catch (err) {
      if (logger) await logger.debug(`Steam: could not read libraryfolders.vdf in ${root}: ${err.message}`);
    }

    for (const lib of libraries) {
      const steamapps = path.join(lib, 'steamapps');
      let entries = [];
      try {
        entries = await fsp.readdir(steamapps);
      } catch { continue; }
      for (const name of entries) {
        if (!/^appmanifest_\d+\.acf$/i.test(name)) continue;
        try {
          const acf = parseVdf(await fsp.readFile(path.join(steamapps, name), 'utf8'));
          const info = extractAppInfo(acf);
          if (!info || !info.name || !info.installDir) continue;
          // StateFlags 4 = fully installed.
          if (info.StateFlags !== null && (info.StateFlags & 4) === 0) continue;
          const installDir = path.join(steamapps, 'common', info.installDir);
          if (!fs.existsSync(installDir)) continue;
          games.push({
            id: `steam-${info.appId || info.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: info.name,
            provider: 'steam',
            installDir,
            exeName: info.launcherExe || null,
            appId: info.appId,
          });
        } catch (err) {
          if (logger) await logger.debug(`Steam: failed to parse ${name}: ${err.message}`);
        }
      }
    }
  }
  return games;
}

module.exports = { detect, findSteamRoots };
