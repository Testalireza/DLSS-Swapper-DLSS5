'use strict';

const fsp = require('fs').promises;
const path = require('path');

/**
 * HistoryService — append-only installation history (history.json).
 *
 * Records every runtime swap, injection install/uninstall and restore with
 * enough context to understand and undo it: versions, method, backup id,
 * result and the per-step outcome.
 */

const MAX_ENTRIES = 500;

class HistoryService {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   */
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.file = env.paths.history;
    this._cache = null;
  }

  async _load() {
    if (this._cache) return this._cache;
    try {
      const doc = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this._cache = Array.isArray(doc.entries) ? doc.entries : [];
    } catch {
      this._cache = [];
    }
    return this._cache;
  }

  async _save() {
    const entries = await this._load();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ schemaVersion: 1, entries }, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /**
   * Add an entry.
   * @param {object} e {gameId, gameName, action, fromVersion?, toVersion?,
   *   method?, injectionId?, injectionName?, backupId?, result, details?, steps?}
   */
  async add(e) {
    const entries = await this._load();
    const entry = {
      id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      result: 'success',
      ...e,
    };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    await this._save();
    return entry;
  }

  async list(limit = 100, gameId = null) {
    const entries = await this._load();
    const filtered = gameId ? entries.filter((e) => e.gameId === gameId) : entries;
    return filtered.slice(0, limit);
  }

  async get(id) {
    const entries = await this._load();
    return entries.find((e) => e.id === id) || null;
  }

  /** Update the result of an existing entry (e.g. after a rollback report). */
  async update(id, patch) {
    const entries = await this._load();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    await this._save();
    return entry;
  }

  async clear() {
    this._cache = [];
    await this._save();
  }
}

module.exports = { HistoryService };
