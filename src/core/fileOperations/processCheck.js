'use strict';

const path = require('path');

/**
 * Process check — warn before touching files of a running game.
 *
 * Windows: `tasklist /FI "IMAGENAME eq x.exe" /FO CSV /NH`
 * Linux/macOS: `pgrep -x <name>` (dev-preview + Steam Deck style setups)
 *
 * The runner is injectable so tests can simulate a running game deterministically.
 */

/**
 * @param {import('../env').AppEnv} env
 * @param {string[]} exeNames Names to check, e.g. ['game.exe'] (extension optional).
 * @returns {Promise<{running:boolean, processes:Array<{pid:number,name:string}>, checked:string[], error?:string}>}
 */
async function areProcessesRunning(env, exeNames) {
  const names = (exeNames || []).filter(Boolean).map((n) => path.basename(n));
  if (!names.length) return { running: false, processes: [], checked: [] };
  const processes = [];
  const errors = [];

  if (env.isWindows) {
    for (const name of names) {
      const withExt = /\.exe$/i.test(name) ? name : `${name}.exe`;
      try {
        const { stdout } = await env.runner('tasklist', ['/FI', `IMAGENAME eq ${withExt}`, '/FO', 'CSV', '/NH'], { timeout: 8000 });
        // CSV lines: "game.exe","1234","Console","1","123,456 K"
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)"/);
          if (m && m[1].toLowerCase() === withExt.toLowerCase()) {
            processes.push({ pid: Number(m[2]), name: m[1] });
          }
        }
      } catch (err) {
        errors.push(`${withExt}: ${err.message}`);
      }
    }
  } else {
    for (const name of names) {
      const bare = name.replace(/\.exe$/i, '');
      try {
        const { stdout } = await env.runner('pgrep', ['-x', bare], { timeout: 5000 });
        for (const line of stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          processes.push({ pid: Number(line), name: bare });
        }
      } catch {
        // pgrep exits non-zero when nothing matches — that's "not running".
      }
    }
  }

  return {
    running: processes.length > 0,
    processes,
    checked: names,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

module.exports = { areProcessesRunning };
