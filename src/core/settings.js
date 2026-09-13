'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { makeId } = require('../shared/format');

/**
 * SettingsService — JSON settings store in the app data directory.
 *
 * All defaults live here (single source of truth); the renderer never stores
 * state of its own beyond the current page.
 */

const DEFAULTS = Object.freeze({
  // Appearance
  theme: 'light', // 'light' | 'dark'
  compactGameCards: false,

  // Game scanning
  scan: {
    steam: true,
    epic: true,
    xbox: true,
    gog: true,
    customFolders: true,
  },
  customGameFolders: [], // string[] — extra folders scanned for game installs
  scanDepth: 3, // how deep custom folder scanning descends

  // Backups
  backupDir: null, // null => <dataDir>/Backups
  autoBackup: true, // always back up before modifying anything
  keepBackupCount: 0, // 0 = keep everything

  // Safety / verification
  verifyAfterInstall: true,
  warnOnConflicts: true,
  blockIfGameRunning: true,

  // Information & logging
  showAdvancedInfo: false,
  advancedMode: false,
  loggingEnabled: true,
  verboseLogging: false,
  gpuCompatibilityOverride: false, // advanced: proceed despite unverified GPU

  // Runtime sources (providers)
  runtimeSources: {
    github: {
      enabled: true,
      // Repository release assets to try, in order. Placeholders:
      //   {version} — runtime version, {file} — file name.
      repos: [
        'https://github.com/Testalireza/DLSS-Swapper-DLSS5-Runtimes/releases/download/{version}/{file}',
      ],
    },
  },

  // App update channel
  updateRepo: 'Testalireza/DLSS-Swapper-DLSS5',
});

class SettingsService {
  /**
   * @param {import('./env').AppEnv} env
   */
  constructor(env) {
    this.env = env;
    this.file = env.paths.settings;
    this._cache = null;
    this._listeners = new Set();
  }

  /** Deep-merge helper so new defaults appear for existing users. */
  static _merge(base, override) {
    if (override === undefined || override === null) return base;
    if (Array.isArray(base) || typeof base !== 'object') return override;
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in base ? SettingsService._merge(base[k], v) : v;
    }
    return out;
  }

  async get() {
    if (this._cache) return this._cache;
    let stored = {};
    try {
      stored = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      stored = {}; // first run or corrupted — fall back to defaults
    }
    this._cache = SettingsService._merge(structuredClone(DEFAULTS), stored);
    return this._cache;
  }

  /**
   * Update settings. `patch` may use dot paths: { 'scan.steam': false }.
   */
  async set(patch) {
    const current = await this.get();
    for (const [key, value] of Object.entries(patch || {})) {
      const parts = key.split('.');
      let target = current;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    }
    await this._save(current);
    return current;
  }

  /** Reset to defaults. The old file is kept next to it for recovery. */
  async reset() {
    try {
      await fsp.access(this.file);
      const archived = path.join(path.dirname(this.file), `settings.backup-${makeId()}.json`);
      await fsp.copyFile(this.file, archived);
    } catch {
      /* nothing to archive */
    }
    this._cache = structuredClone(DEFAULTS);
    await this._save(this._cache);
    return this._cache;
  }

  /** Effective backup root, honouring the user override. */
  async backupRoot() {
    const s = await this.get();
    return s.backupDir || this.env.paths.backups;
  }

  async _save(settings) {
    this._cache = settings;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
    for (const l of this._listeners) {
      try { l(settings); } catch { /* listener errors must not break saves */ }
    }
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}

SettingsService.DEFAULTS = DEFAULTS;

module.exports = { SettingsService, DEFAULTS };
