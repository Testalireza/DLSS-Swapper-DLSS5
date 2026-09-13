'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * Epic Games detector.
 *
 * Reads the Epic Games Launcher manifest store:
 *   %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item   (JSON)
 *   %ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat
 *
 * `opts.roots` (manifest dirs) and `opts.datFiles` override discovery for tests.
 */

async function findManifestDirs(env) {
  if (!env.isWindows) return [];
  return [
    env.expandEnvVars('%ProgramData%\\Epic\\EpicGamesLauncher\\Data\\Manifests'),
    env.expandEnvVars('%ProgramData%\\Epic\\UnrealEngineLauncher\\Data\\Manifests'),
  ].filter((d) => fs.existsSync(d));
}

async function findDatFiles(env) {
  if (!env.isWindows) return [];
  return [
    env.expandEnvVars('%ProgramData%\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat'),
    env.expandEnvVars('%ProgramData%\\Epic\\EpicGamesLauncher\\Data\\Manifests\\..\\LauncherInstalled.dat'),
  ].filter((f) => fs.existsSync(f));
}

async function detect(env, opts = {}) {
  const logger = opts.logger;
  const games = [];
  const seen = new Set();

  const add = (g) => {
    if (!g || !g.installDir || !fs.existsSync(g.installDir)) return;
    const key = path.resolve(g.installDir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    games.push(g);
  };

  // *.item manifests
  const dirs = opts.roots || (await findManifestDirs(env));
  for (const dir of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.item')) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        add({
          id: `epic-${m.AppName || m.InstallLocation || name}`,
          name: m.DisplayName || m.AppName || name,
          provider: 'epic',
          installDir: m.InstallLocation,
          exeName: m.LaunchExecutable || null,
          appName: m.AppName || null,
        });
      } catch (err) {
        if (logger) await logger.debug(`Epic: failed to parse ${name}: ${err.message}`);
      }
    }
  }

  // LauncherInstalled.dat
  const dats = opts.datFiles || (await findDatFiles(env));
  for (const file of dats) {
    try {
      const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
      for (const inst of doc.InstallationList || []) {
        add({
          id: `epic-${inst.AppName || inst.InstallLocation}`,
          name: inst.AppName || path.basename(inst.InstallLocation || 'Epic Game'),
          provider: 'epic',
          installDir: inst.InstallLocation,
          exeName: inst.LaunchExecutable || null,
          appName: inst.AppName || null,
        });
      }
    } catch (err) {
      if (logger) await logger.debug(`Epic: failed to parse ${file}: ${err.message}`);
    }
  }

  return games;
}

module.exports = { detect, findManifestDirs };
