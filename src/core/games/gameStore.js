'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const steam = require('./detectors/steam');
const epic = require('./detectors/epic');
const xbox = require('./detectors/xbox');
const gog = require('./detectors/gog');
const folders = require('./detectors/folders');

/**
 * GameStore — the single source of truth for "which games do we know".
 *
 * Persisted (games.json): manual games, ignored ids, per-game executable
 * choices, and the last scan result (so the UI can show something before a
 * fresh scan finishes). Detection itself always runs live.
 */

const PROVIDER_PRIORITY = ['manual', 'steam', 'epic', 'xbox', 'gog', 'folder'];

class GameStore {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   * @param {import('../settings').SettingsService} settings
   */
  constructor(env, logger, settings) {
    this.env = env;
    this.logger = logger;
    this.settings = settings;
    this.file = env.paths.games;
    this._state = null;
  }

  async _load() {
    if (this._state) return this._state;
    try {
      this._state = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      this._state = {};
    }
    this._state.manual = Array.isArray(this._state.manual) ? this._state.manual : [];
    this._state.ignored = Array.isArray(this._state.ignored) ? this._state.ignored : [];
    this._state.exeChoices = this._state.exeChoices && typeof this._state.exeChoices === 'object' ? this._state.exeChoices : {};
    this._state.cache = Array.isArray(this._state.cache) ? this._state.cache : [];
    return this._state;
  }

  async _save() {
    const state = await this._load();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** Run all enabled detectors and merge with manual games. */
  async scan(onProgress = () => {}) {
    const state = await this._load();
    const settings = await this.settings.get();
    const detected = [];
    const jobs = [];
    const run = async (id, label, fn) => {
      if (settings.scan && settings.scan[id] === false) return;
      onProgress({ detector: label, phase: 'start' });
      try {
        const games = await fn();
        detected.push(...games);
        onProgress({ detector: label, phase: 'done', count: games.length });
        await this.logger.info(`${label} detection: ${games.length} game(s) found`);
      } catch (err) {
        onProgress({ detector: label, phase: 'error', error: err.message });
        await this.logger.errorObj(`${label} detection failed`, err);
      }
    };
    jobs.push(run('steam', 'Steam', () => steam.detect(this.env, { logger: this.logger })));
    jobs.push(run('epic', 'Epic Games', () => epic.detect(this.env, { logger: this.logger })));
    jobs.push(run('xbox', 'Xbox / MS Store', () => xbox.detect(this.env, { logger: this.logger })));
    jobs.push(run('gog', 'GOG', () => gog.detect(this.env, { logger: this.logger })));
    jobs.push(run('customFolders', 'Custom folders', () => folders.detect(this.env, { settings, logger: this.logger })));
    await Promise.all(jobs);

    const merged = this._merge(state.manual, detected);
    state.cache = merged.map((g) => ({ ...g, _cachedAt: new Date().toISOString() }));
    state.lastScan = new Date().toISOString();
    await this._save();
    await this.logger.success(`Game scan complete: ${merged.length} game(s) in library`);
    return this.list();
  }

  /** Current library: manual games + cached scan results, de-duplicated. */
  async list() {
    const state = await this._load();
    const all = this._merge(state.manual, state.cache);
    return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async get(id) {
    const all = await this.list();
    return all.find((g) => g.id === id) || null;
  }

  _merge(manual, detected) {
    const byDir = new Map();
    const push = (game) => {
      const key = path.resolve(game.installDir || '').toLowerCase();
      if (!key) return;
      const existing = byDir.get(key);
      if (!existing) { byDir.set(key, { ...game }); return; }
      const a = PROVIDER_PRIORITY.indexOf(existing.provider);
      const b = PROVIDER_PRIORITY.indexOf(game.provider);
      if (b < a) {
        // Keep manual-game id/stability while refreshing detected metadata.
        byDir.set(key, { ...existing, ...game, id: existing.provider === 'manual' ? existing.id : game.id });
      } else if (!existing.exeName && game.exeName) {
        existing.exeName = game.exeName;
      }
    };
    for (const g of manual) push(g);
    for (const g of detected) push(g);
    const state = this._state;
    const ignored = new Set(state ? state.ignored : []);
    return [...byDir.values()]
      .filter((g) => !ignored.has(g.id))
      .map((g) => (g.exePath ? g : state && state.exeChoices[g.id] ? { ...g, exePath: state.exeChoices[g.id], exeChosenManually: true } : g));
  }

  /** Add a game the detectors missed. */
  async addManual({ name, installDir, exePath }) {
    const state = await this._load();
    const dir = installDir && path.resolve(installDir);
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(`Folder does not exist: ${installDir}`);
    }
    if (exePath && !fs.existsSync(exePath)) {
      throw new Error(`Executable does not exist: ${exePath}`);
    }
    const slug = String(name || path.basename(dir)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `manual-${slug}-${Date.now().toString(36)}`;
    state.manual.push({
      id,
      name: name || path.basename(dir),
      provider: 'manual',
      installDir: dir,
      exePath: exePath || null,
      exeName: exePath ? path.basename(exePath) : null,
      addedAt: new Date().toISOString(),
    });
    await this._save();
    await this.logger.info(`Manual game added: ${name || dir}`);
    return id;
  }

  async removeManual(id) {
    const state = await this._load();
    const before = state.manual.length;
    state.manual = state.manual.filter((g) => g.id !== id);
    if (state.manual.length === before) return { ok: false, reason: 'not-a-manual-game' };
    await this._save();
    return { ok: true };
  }

  /** Hide a detected game from the library (never deletes anything). */
  async setIgnored(id, ignored) {
    const state = await this._load();
    const set = new Set(state.ignored);
    if (ignored) set.add(id); else set.delete(id);
    state.ignored = [...set];
    await this._save();
    return { ok: true };
  }

  /** Persist the user's executable choice for games with multiple candidates. */
  async chooseExecutable(id, exePath) {
    const state = await this._load();
    if (exePath) state.exeChoices[id] = exePath;
    else delete state.exeChoices[id];
    await this._save();
    return { ok: true };
  }
}

module.exports = { GameStore };
