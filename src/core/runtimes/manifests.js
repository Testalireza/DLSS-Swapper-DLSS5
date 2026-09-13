'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { compareVersions } = require('../../shared/format');
const { FILE_ROLES } = require('../../shared/constants');

/**
 * ManifestStore — loads the runtime version database.
 *
 * All JSON files in resources/RuntimeManifests are loaded and merged, so new
 * versions can be added by dropping in another manifest without touching code.
 * Entries are validated defensively; malformed entries are reported, not fatal.
 */
class ManifestStore {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   */
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this._runtimes = null;
    this._fileCatalog = {};
    this._loadErrors = [];
  }

  async _load() {
    if (this._runtimes) return;
    const dir = this.env.paths.manifests;
    const runtimes = new Map();
    this._loadErrors = [];
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'));
    } catch (err) {
      this._loadErrors.push({ file: dir, error: `manifest folder unreadable: ${err.message}` });
      this._runtimes = [];
      return;
    }
    for (const file of files.sort()) {
      const full = path.join(dir, file);
      try {
        const doc = JSON.parse(await fsp.readFile(full, 'utf8'));
        if (doc.fileCatalog) Object.assign(this._fileCatalog, doc.fileCatalog);
        for (const entry of doc.runtimes || []) {
          const problems = ManifestStore.validateEntry(entry);
          if (problems.length) {
            this._loadErrors.push({ file, version: entry && entry.version, error: problems.join('; ') });
            continue;
          }
          // Normalise file entries against the catalog defaults.
          entry.files = (entry.files || []).map((f) => {
            const cat = this._fileCatalog[f.name] || {};
            return {
              name: f.name,
              role: f.role || cat.role || FILE_ROLES.OTHER,
              required: f.required !== undefined ? !!f.required : !!cat.required,
              sha256: f.sha256 || null,
              sizeBytes: Number.isFinite(f.sizeBytes) ? f.sizeBytes : null,
            };
          });
          if (runtimes.has(entry.version)) {
            this._loadErrors.push({ file, version: entry.version, error: 'duplicate version (first definition kept)' });
            continue;
          }
          runtimes.set(entry.version, { ...entry, manifestFile: file });
        }
      } catch (err) {
        this._loadErrors.push({ file, error: `parse failure: ${err.message}` });
      }
    }
    this._runtimes = [...runtimes.values()].sort((a, b) => compareVersions(a.version, b.version));
    await this.logger.info(`Runtime manifest database loaded: ${this._runtimes.length} version(s) from ${files.length} file(s)`);
  }

  static validateEntry(entry) {
    const problems = [];
    if (!entry || typeof entry !== 'object') return ['entry is not an object'];
    if (!entry.version || !/^\d+(\.\d+)*$/.test(entry.version)) problems.push(`missing/invalid version "${entry.version}"`);
    if (!Array.isArray(entry.files) || entry.files.length === 0) problems.push('no files declared');
    else {
      const core = entry.files.find((f) => f.required);
      if (!core) problems.push('no file marked required');
      for (const f of entry.files) {
        if (!f.name) problems.push('file entry without a name');
      }
    }
    return problems;
  }

  /** Force reload (after the user edits/adds manifests). */
  async reload() {
    this._runtimes = null;
    this._fileCatalog = {};
    await this._load();
    return this.list();
  }

  /** All known runtime versions, sorted ascending. */
  async list() {
    await this._load();
    return this._runtimes;
  }

  /** Newest supported version (last in sorted order). */
  async latest() {
    const all = await this.list();
    return all.length ? all[all.length - 1] : null;
  }

  /** Look up one manifest entry by exact version string. */
  async get(version) {
    const all = await this.list();
    return all.find((r) => r.version === version) || null;
  }

  loadErrors() {
    return this._loadErrors;
  }

  fileCatalog() {
    return this._fileCatalog;
  }
}

module.exports = { ManifestStore };
