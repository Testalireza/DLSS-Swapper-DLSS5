'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * Logger — rotating daily text log files plus an in-memory ring buffer the UI
 * can display. Levels mirror the spec examples:
 *
 *   [INFO] Game detected: Example Game
 *   [SUCCESS] Backup completed
 *   [WARN] ...
 *   [ERROR] ...
 *   [DEBUG] ... (only when verbose logging / advanced mode is on)
 */

const LEVELS = Object.freeze({ DEBUG: 0, INFO: 1, SUCCESS: 1, WARN: 2, ERROR: 3 });
const RING_SIZE = 500;

class Logger {
  /**
   * @param {import('./env').AppEnv} env
   * @param {import('./settings').SettingsService} settings
   */
  constructor(env, settings) {
    this.env = env;
    this.settings = settings;
    this.ring = [];
    this._listeners = new Set();
    this._pendingWrites = Promise.resolve();
  }

  _today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  logFile() {
    return path.join(this.env.paths.logs, `app-${this._today()}.log`);
  }

  /**
   * @param {'DEBUG'|'INFO'|'SUCCESS'|'WARN'|'ERROR'} level
   * @param {string} message
   * @param {object} [meta] Structured context (gameId, error, ...).
   */
  async log(level, message, meta) {
    const settings = this.settings ? await this.settings.get().catch(() => null) : null;
    const loggingEnabled = settings ? settings.loggingEnabled !== false : true;
    const verbose = settings ? (settings.verboseLogging || settings.advancedMode) : false;
    if (level === 'DEBUG' && !verbose) {
      // Still keep debug lines in the ring for the UI when verbose flips on? No —
      // spec says don't expose technical detail to normal users. Drop them.
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      message: String(message),
      ...(meta ? { meta } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    for (const l of this._listeners) {
      try { l(entry); } catch { /* ignore */ }
    }

    if (!loggingEnabled) return;

    const line = Logger.formatLine(entry);
    // Serialize writes so lines never interleave inside one entry.
    this._pendingWrites = this._pendingWrites.then(async () => {
      try {
        await fsp.mkdir(this.env.paths.logs, { recursive: true });
        await fsp.appendFile(this.logFile(), line + '\n', 'utf8');
      } catch {
        /* Never let logging break the app. */
      }
    });
    await this._pendingWrites.catch(() => {});
  }

  static formatLine(entry) {
    const metaStr = entry.meta ? ` ${safeJson(entry.meta)}` : '';
    return `[${entry.ts}] [${entry.level}] ${entry.message}${metaStr}`;
  }

  debug(msg, meta) { return this.log('DEBUG', msg, meta); }
  info(msg, meta) { return this.log('INFO', msg, meta); }
  success(msg, meta) { return this.log('SUCCESS', msg, meta); }
  warn(msg, meta) { return this.log('WARN', msg, meta); }
  error(msg, meta) { return this.log('ERROR', msg, meta); }

  /** Log an Error object with a friendly message; stack only reaches the file log. */
  async errorObj(msg, err) {
    return this.log('ERROR', `${msg}: ${err && err.message ? err.message : err}`, {
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
    });
  }

  recent(limit = 200) {
    return this.ring.slice(Math.max(0, this.ring.length - limit));
  }

  onEntry(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Copy today's log (and the ring buffer) to a user-chosen export path. */
  async exportTo(targetFile) {
    await fsp.mkdir(path.dirname(targetFile), { recursive: true });
    let contents = `DLSS Swapper 5 — log export ${new Date().toISOString()}\n\n`;
    try {
      contents += await fsp.readFile(this.logFile(), 'utf8');
    } catch {
      contents += '(no log file for today)\n';
    }
    contents += '\n--- recent in-memory entries ---\n';
    contents += this.ring.map(Logger.formatLine).join('\n');
    await fsp.writeFile(targetFile, contents, 'utf8');
    return targetFile;
  }

  /** Prune log files older than `days`. */
  async prune(days = 14) {
    try {
      const entries = await fsp.readdir(this.env.paths.logs);
      const cutoff = Date.now() - days * 86400000;
      for (const name of entries) {
        if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const file = path.join(this.env.paths.logs, name);
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < cutoff) await fsp.unlink(file);
      }
    } catch { /* best effort */ }
  }
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}

/** A logger that swallows everything — handy for tests that don't care. */
class NullLogger extends Logger {
  constructor() { super({ paths: { logs: path.join(require('os').tmpdir(), 'dlss5-null-logs') } }, null); }
  async log() {}
  async exportTo() { return null; }
}

module.exports = { Logger, NullLogger, LEVELS };
// Export fs so tests can stub if they must (not used internally beyond fsp).
module.exports._fs = fs;
