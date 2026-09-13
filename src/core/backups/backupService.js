'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile, verifyFileHash } = require('../hash');
const { makeId } = require('../../shared/format');
const { APP } = require('../../shared/constants');

/**
 * BackupService — the safety net under every modification.
 *
 * Layout (per spec):
 *   <backupRoot>/<Game Name>-<gameId>/
 *     └── <backupId>/
 *           ├── metadata.json
 *           └── files/<relative path preserved>
 *
 * Rules enforced here:
 *  - A backup is created BEFORE any target file is touched.
 *  - Backup IDs are unique; an existing backup directory is never overwritten
 *    (create() retries with a fresh id if a collision somehow occurs).
 *  - Every copied file is hash-verified after copying.
 *  - Restore validates the backup first, then restores atomically and
 *    verifies the restored files.
 *  - Restore deletes files *we added* only when their current hash still
 *    matches what the operation installed — never a user's newer file.
 */

class BackupService {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   * @param {import('../settings').SettingsService} settings
   */
  constructor(env, logger, settings) {
    this.env = env;
    this.logger = logger;
    this.settings = settings;
  }

  async root() {
    return this.settings.backupRoot();
  }

  /** Folder name for a game's backups: readable + unique. */
  gameDirName(game) {
    const safe = String(game.name || 'Game').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60).trim();
    return `${safe}-${game.id}`;
  }

  async gameBackupDir(game) {
    const root = await this.root();
    return path.join(root, this.gameDirName(game));
  }

  // ---------------------------------------------------------------- create

  /**
   * Create a backup of files that are about to be replaced/removed.
   *
   * @param {object} opts
   * @param {object} opts.game         Game record {id, name, installDir}.
   * @param {string} opts.targetDir    Folder the operation writes into.
   * @param {Array<{relPath:string}>} opts.files  Existing files to preserve
   *        (relative to targetDir). Empty array is allowed when the operation
   *        only ADDS files.
   * @param {object} opts.operation    {type, version?, method?, injectionId?, injectionName?}
   * @param {object} [opts.runtimeBefore] {dlss, streamline} detected before the op.
   * @param {string[]} [opts.willAdd]  relPaths the operation will add (recorded
   *        so restore knows what to remove).
   * @returns {Promise<{ok:boolean, backupId?:string, dir?:string, error?:string}>}
   */
  async create(opts) {
    const { game, targetDir, files = [], operation, runtimeBefore = null, willAdd = [] } = opts;
    const root = await this.root();
    const gameDir = path.join(root, this.gameDirName(game));

    let backupId = makeId();
    let dir = path.join(gameDir, backupId);
    // Never clobber an existing backup — pick a fresh id on collision.
    for (let attempt = 0; fs.existsSync(dir) && attempt < 10; attempt++) {
      backupId = makeId();
      dir = path.join(gameDir, backupId);
    }
    if (fs.existsSync(dir)) {
      return { ok: false, error: 'Could not allocate a unique backup id (existing backup preserved).' };
    }

    const filesRoot = path.join(dir, 'files');
    await fsp.mkdir(filesRoot, { recursive: true });

    const modifiedFiles = [];
    try {
      for (const f of files) {
        const abs = path.isAbsolute(f.relPath) ? f.relPath : path.join(targetDir, f.relPath);
        const rel = path.relative(targetDir, abs) || path.basename(abs);
        const stat = await fsp.stat(abs);
        const originalHash = await hashFile(abs);
        const backupRel = path.join('files', rel);
        const backupAbs = path.join(dir, backupRel);
        await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
        await fsp.copyFile(abs, backupAbs);
        // Verify the backup copy itself before it is allowed to count.
        const backupHash = await hashFile(backupAbs);
        if (backupHash !== originalHash) {
          throw new Error(`Backup copy verification failed for ${rel} (source may be in use).`);
        }
        modifiedFiles.push({
          relPath: rel,
          absPath: abs,
          kind: 'replaced',
          originalHash,
          sizeBytes: stat.size,
          modified: stat.mtime.toISOString(),
          backupRelPath: backupRel,
          backupHash,
        });
      }
    } catch (err) {
      // Partial backup dir is useless and dangerous to keep around as "valid";
      // remove it so nothing ever restores from an incomplete backup.
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await this.logger.errorObj('Backup creation failed — nothing was modified', err);
      return { ok: false, error: err.message };
    }

    const metadata = {
      schemaVersion: 1,
      backupId,
      game: { id: game.id, name: game.name, installDir: game.installDir, targetDir },
      created: new Date().toISOString(),
      appVersion: APP.version,
      operation: operation || {},
      runtimeBefore,
      modifiedFiles,
      addedFiles: [],
      willAdd: willAdd.map((relPath) => ({ relPath })),
      result: 'pending', // finalized by the installer after verify/rollback
    };
    await fsp.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
    await this.logger.success(`Backup created: ${backupId} for "${game.name}" (${modifiedFiles.length} file(s) preserved)`);
    return { ok: true, backupId, dir, metadata };
  }

  /**
   * Finalize metadata after the operation completes: record added files (with
   * the hash that was installed) and the outcome.
   */
  async finalize(gameId, backupId, { addedFiles = [], result = 'success' } = {}) {
    const meta = await this.getMetadata(gameId, backupId);
    if (!meta) return { ok: false, error: 'backup not found' };
    meta.addedFiles = addedFiles;
    meta.result = result;
    meta.finishedAt = new Date().toISOString();
    await fsp.writeFile(this.metadataPath(meta), JSON.stringify(meta, null, 2), 'utf8');
    return { ok: true, metadata: meta };
  }

  // ------------------------------------------------------------------ read

  metadataPath(meta) {
    return path.join(meta.__dir, 'metadata.json');
  }

  async getMetadata(gameId, backupId) {
    const root = await this.root();
    // gameId may be a full game dir name or just the id suffix.
    let gameDirs = [];
    try { gameDirs = await fsp.readdir(root); } catch { return null; }
    const matches = gameDirs.filter((d) => d.endsWith(`-${gameId}`) || d === gameId);
    for (const gd of matches) {
      const metaPath = path.join(root, gd, backupId, 'metadata.json');
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        meta.__dir = path.join(root, gd, backupId);
        return meta;
      } catch { /* try next */ }
    }
    return null;
  }

  /** All backups, newest first. Optionally filtered by game id. */
  async list(gameId = null) {
    const root = await this.root();
    let gameDirs = [];
    try { gameDirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const gd of gameDirs) {
      if (!gd.isDirectory()) continue;
      if (gameId && !(gd.name.endsWith(`-${gameId}`) || gd.name === gameId)) continue;
      let backupDirs = [];
      try { backupDirs = await fsp.readdir(path.join(root, gd.name), { withFileTypes: true }); } catch { continue; }
      for (const bd of backupDirs) {
        if (!bd.isDirectory()) continue;
        try {
          const meta = JSON.parse(await fsp.readFile(path.join(root, gd.name, bd.name, 'metadata.json'), 'utf8'));
          meta.__dir = path.join(root, gd.name, bd.name);
          out.push(meta);
        } catch {
          out.push({
            schemaVersion: 1, backupId: bd.name, corrupt: true,
            game: { id: gd.name.replace(/^.+-/, ''), name: gd.name.replace(/-[^-]+$/, '') },
            created: null, operation: {}, modifiedFiles: [], addedFiles: [],
            __dir: path.join(root, gd.name, bd.name),
          });
        }
      }
    }
    out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return out;
  }

  // -------------------------------------------------------------- validate

  /**
   * Validate a backup is complete and untouched:
   * metadata readable, every preserved file present with a matching hash.
   */
  async validate(gameId, backupId) {
    const meta = await this.getMetadata(gameId, backupId);
    if (!meta) return { ok: false, problems: ['Backup metadata not found.'] };
    if (meta.corrupt) return { ok: false, problems: ['Backup metadata is corrupt.'] };
    const problems = [];
    for (const f of meta.modifiedFiles || []) {
      const abs = path.join(meta.__dir, f.backupRelPath);
      const res = await verifyFileHash(abs, f.backupHash || f.originalHash);
      if (!res.ok) problems.push(`${f.relPath}: backup copy failed verification (${res.reason})`);
    }
    return { ok: problems.length === 0, problems, metadata: meta };
  }

  // --------------------------------------------------------------- restore

  /**
   * Restore original files.
   *
   * @param {string} gameId
   * @param {string} backupId
   * @param {object} [opts]
   * @param {(p:{step:string, detail?:string, percent?:number})=>void} [opts.onProgress]
   * @param {boolean} [opts.dryRun] Only report what would happen.
   */
  async restore(gameId, backupId, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const report = { restored: [], deleted: [], warnings: [], errors: [] };

    onProgress({ step: 'validate', detail: 'Validating backup…' });
    const v = await this.validate(gameId, backupId);
    if (!v.ok) {
      report.errors.push(...v.problems);
      await this.logger.error(`Restore aborted — backup ${backupId} failed validation: ${v.problems.join('; ')}`);
      return { ok: false, ...report };
    }
    const meta = v.metadata;
    const targetDir = meta.game.targetDir;

    if (opts.dryRun) {
      for (const f of meta.modifiedFiles || []) report.restored.push({ relPath: f.relPath, action: 'restore-original' });
      for (const f of meta.addedFiles || []) report.deleted.push({ relPath: f.relPath, action: 'remove-added' });
      return { ok: true, dryRun: true, ...report, metadata: meta };
    }

    if (!fs.existsSync(targetDir)) {
      report.errors.push(`Game folder no longer exists: ${targetDir}`);
      return { ok: false, ...report };
    }

    // 1. Restore preserved originals (temp file + rename = atomic per file).
    const total = (meta.modifiedFiles || []).length + (meta.addedFiles || []).length;
    let done = 0;
    for (const f of meta.modifiedFiles || []) {
      const abs = path.isAbsolute(f.relPath) ? f.relPath : path.join(targetDir, f.relPath);
      const backupAbs = path.join(meta.__dir, f.backupRelPath);
      try {
        const currentHash = fs.existsSync(abs) ? await hashFile(abs) : null;
        if (currentHash === f.originalHash) {
          report.warnings.push(`${f.relPath}: already identical to the original — left untouched.`);
        } else {
          const tmp = `${abs}.dlss5restore-${Date.now()}`;
          await fsp.copyFile(backupAbs, tmp);
          const tmpHash = await hashFile(tmp);
          if (tmpHash !== (f.backupHash || f.originalHash)) throw new Error('staged restore copy failed hash verification');
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.rename(tmp, abs);
          const check = await verifyFileHash(abs, f.originalHash);
          if (!check.ok) throw new Error(`post-restore verification failed for ${f.relPath} (${check.reason})`);
          report.restored.push({ relPath: f.relPath, action: 'restore-original' });
        }
      } catch (err) {
        report.errors.push(`${f.relPath}: ${err.message}`);
        await this.logger.errorObj(`Restore failed for ${f.relPath}`, err);
      }
      done++;
      onProgress({ step: 'restore', detail: f.relPath, percent: total ? Math.round((done / total) * 100) : 100 });
    }

    // 2. Remove files the operation ADDED — but only if they are still ours.
    for (const f of meta.addedFiles || []) {
      const abs = path.isAbsolute(f.relPath) ? f.relPath : path.join(targetDir, f.relPath);
      try {
        if (!fs.existsSync(abs)) {
          report.warnings.push(`${f.relPath}: added file is already gone.`);
        } else if (f.installedHash) {
          const current = await hashFile(abs);
          if (current === f.installedHash) {
            await fsp.unlink(abs);
            report.deleted.push({ relPath: f.relPath, action: 'remove-added' });
          } else {
            report.warnings.push(`${f.relPath}: file was changed after installation — kept for safety (delete manually if desired).`);
          }
        } else {
          report.warnings.push(`${f.relPath}: no installed hash recorded — kept for safety.`);
        }
      } catch (err) {
        report.errors.push(`${f.relPath}: ${err.message}`);
      }
      done++;
      onProgress({ step: 'restore', detail: f.relPath, percent: total ? Math.round((done / total) * 100) : 100 });
    }

    // 3. Update our marker in the game folder (remove this operation's entry).
    await this._updateMarkerAfterRestore(targetDir, backupId).catch(() => {});

    const ok = report.errors.length === 0;
    await this.logger[ok ? 'success' : 'error'](
      `Restore ${backupId}: ${report.restored.length} file(s) restored, ${report.deleted.length} removed, ${report.warnings.length} warning(s)${ok ? '' : `, ${report.errors.length} error(s)`}`
    );
    return { ok, ...report, metadata: meta };
  }

  async _updateMarkerAfterRestore(targetDir, backupId) {
    const markerPath = path.join(targetDir, APP.markerFileName);
    if (!fs.existsSync(markerPath)) return;
    try {
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      marker.operations = (marker.operations || []).filter((op) => op.backupId !== backupId);
      if (marker.operations.length === 0) {
        await fsp.unlink(markerPath);
      } else {
        await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
      }
    } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- delete

  /** Delete a backup (manual user action only). */
  async delete(gameId, backupId) {
    const meta = await this.getMetadata(gameId, backupId);
    if (!meta) return { ok: false, error: 'backup not found' };
    await fsp.rm(meta.__dir, { recursive: true, force: true });
    await this.logger.warn(`Backup deleted by user: ${backupId} (${meta.game ? meta.game.name : gameId})`);
    return { ok: true };
  }

  /** Total size on disk of all backups (for the Options page). */
  async totalSize() {
    const root = await this.root();
    const walk = async (dir) => {
      let total = 0;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) total += await walk(p);
        else { const s = await fsp.stat(p).catch(() => null); if (s) total += s.size; }
      }
      return total;
    };
    return walk(root);
  }
}

module.exports = { BackupService };
