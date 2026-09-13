'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { APP } = require('../shared/constants');

/**
 * AppEnv — every path and platform-specific capability the core services need,
 * in one injectable object. Tests and the browser dev-preview construct their
 * own env pointing at temp directories; Electron points it at userData.
 */
class AppEnv {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      Root for settings, logs, backups, libraries.
   * @param {string} opts.resourcesDir Root for shipped resources (runtime manifests, icons).
   * @param {string} [opts.platform]   Override platform ('win32' | 'linux' | ...).
   * @param {(cmd:string, args:string[], opts?:object)=>Promise<{stdout:string,stderr:string}>} [opts.runner]
   *        Command runner (injectable for tests).
   * @param {NodeJS.Platform} [opts.homeDir] Override home directory (tests).
   */
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.isWindows = this.platform === 'win32';
    this.homeDir = opts.homeDir || os.homedir();
    this.dataDir = opts.dataDir || path.join(this.homeDir, `.${APP.name.toLowerCase().replace(/\s+/g, '')}-data`);
    this.resourcesDir = opts.resourcesDir || path.join(__dirname, '..', '..', 'resources');
    this.runner = opts.runner || defaultRunner;
    this.env = opts.env || process.env;

    // Well-known sub-locations (created lazily by ensureDirs()).
    this.paths = {
      settings: path.join(this.dataDir, 'settings.json'),
      games: path.join(this.dataDir, 'games.json'),
      history: path.join(this.dataDir, 'history.json'),
      logs: path.join(this.dataDir, 'logs'),
      backups: path.join(this.dataDir, 'Backups'),
      runtimeLibrary: path.join(this.dataDir, 'RuntimeLibrary'),
      injectionLibrary: path.join(this.dataDir, 'InjectionLibrary'),
      staging: path.join(this.dataDir, 'staging'),
      manifests: path.join(this.resourcesDir, 'RuntimeManifests'),
    };
  }

  /** Create the data directory skeleton. Idempotent. */
  async ensureDirs() {
    const dirs = [
      this.dataDir,
      this.paths.logs,
      this.paths.backups,
      this.paths.runtimeLibrary,
      this.paths.injectionLibrary,
      this.paths.staging,
    ];
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
    }
    return this;
  }

  /** Windows: expand %VAR% references in a path string. Other platforms: passthrough. */
  expandEnvVars(p) {
    if (!p) return p;
    return String(p).replace(/%([A-Za-z0-9_]+)%/g, (m, name) => this.env[name] ?? m);
  }
}

/** Default command runner: promisified execFile with sane limits. */
function defaultRunner(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 15000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          reject(err);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code ?? 1 : 0 });
      }
    );
  });
}

/**
 * Locate the directory holding bundled resources at runtime.
 * Under Electron packaged builds, resources live next to the app; in dev they
 * live in the repository. The web dev server passes its own env instead.
 */
function resolveResourcesDir(explicit) {
  if (explicit) return explicit;
  const candidates = [
    path.join(__dirname, '..', '..', 'resources'),
    path.join(process.cwd(), 'resources'),
  ];
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, 'RuntimeManifests', '..'));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'RuntimeManifests'))) return c;
  }
  return candidates[0];
}

module.exports = { AppEnv, defaultRunner, resolveResourcesDir };
