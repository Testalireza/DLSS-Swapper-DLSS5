'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * Xbox / Microsoft Store (PC) detector — best effort.
 *
 * Store titles installed "outside" the locked WindowsApps folder land in
 * C:\XboxGames\<Title>\content (this is where modding is even possible).
 * WindowsApps itself is ACL-locked for normal users; we deliberately do not
 * fight the OS for it and instead report what we can see.
 *
 * The game executable is read from MicrosoftGame.config when present.
 * `opts.roots` overrides discovery for tests.
 */

function parseExecutableFromGameConfig(xml) {
  // <ExecutableList><Executable Name="game.exe" TargetDeviceFamily="PC" .../>
  const matches = [...xml.matchAll(/<Executable\b[^>]*\bName\s*=\s*"([^"]+)"[^>]*\/?>/gi)];
  const pc = matches.filter((m) => /TargetDeviceFamily\s*=\s*"PC"/i.test(m[0]));
  const list = (pc.length ? pc : matches).map((m) => m[1]);
  return list.length ? list : null;
}

async function findXboxRoots(env) {
  const roots = [];
  if (env.isWindows) {
    roots.push('C:\\XboxGames');
    // Some setups move the install location; check the documented registry value.
    try {
      const { stdout } = await env.runner('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\GamingServices', '/v', 'InstallPath',
      ], { timeout: 5000 });
      const m = stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (m) roots.push(m[1].trim());
    } catch { /* fine */ }
    const drive = (env.env.SystemDrive || 'C:').replace(':', '');
    for (const d of ['D', 'E', 'F', 'G']) {
      if (d !== drive) roots.push(`${d}:\\XboxGames`);
    }
  }
  return roots.filter((r) => fs.existsSync(r));
}

async function detect(env, opts = {}) {
  const logger = opts.logger;
  const roots = opts.roots || (await findXboxRoots(env));
  const games = [];
  for (const root of roots) {
    let titles = [];
    try { titles = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const t of titles) {
      if (!t.isDirectory()) continue;
      const content = path.join(root, t.name, 'content');
      const gameDir = fs.existsSync(content) ? content : path.join(root, t.name);
      if (!fs.existsSync(gameDir)) continue;

      let exeName = null;
      try {
        const cfgPath = path.join(gameDir, 'MicrosoftGame.config');
        if (fs.existsSync(cfgPath)) {
          const list = parseExecutableFromGameConfig(await fsp.readFile(cfgPath, 'utf8'));
          if (list) exeName = list[0];
        }
      } catch (err) {
        if (logger) await logger.debug(`Xbox: could not read MicrosoftGame.config for ${t.name}: ${err.message}`);
      }
      games.push({
        id: `xbox-${t.name.toLowerCase()}`,
        name: t.name.replace(/\([A-Za-z0-9]+\)$/, '').trim() || t.name,
        provider: 'xbox',
        installDir: gameDir,
        exeName,
        storeRoot: root,
      });
    }
  }
  return games;
}

module.exports = { detect, parseExecutableFromGameConfig };
