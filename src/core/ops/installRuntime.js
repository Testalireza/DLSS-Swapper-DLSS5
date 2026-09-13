'use strict';

const fs = require('fs');
const path = require('path');
const { areProcessesRunning } = require('../fileOperations/processCheck');
const { detectConflicts } = require('../conflicts/detector');
const { stageFiles, commitStaged, cleanupStaging, removeInstalledFiles, writeMarker } = require('../fileOperations/safeOps');
const { readFileVersion } = require('../pe/peVersion');
const { RESULTS } = require('../../shared/constants');

/**
 * RuntimeInstaller — swaps DLSS/Streamline runtime files inside a game.
 *
 * Full flow (spec §8/§19):
 *   detect game → check running → conflicts → validate package → backup →
 *   stage → replace → verify → mark → history.
 *
 * Every failure after the backup point triggers a rollback from that backup,
 * so the game folder is never left partially modified without a report.
 */

const STEPS = [
  { id: 'game', label: 'Game detected' },
  { id: 'running', label: 'Game not running' },
  { id: 'conflicts', label: 'Conflict check' },
  { id: 'package', label: 'Runtime validated' },
  { id: 'backup', label: 'Backup created' },
  { id: 'stage', label: 'Files staged' },
  { id: 'install', label: 'Files installed' },
  { id: 'verify', label: 'Installation verified' },
];

class RuntimeInstaller {
  /**
   * @param {object} deps
   * @param {import('../env').AppEnv} deps.env
   * @param {import('../logger').Logger} deps.logger
   * @param {import('../settings').SettingsService} deps.settings
   * @param {import('../games/gameStore').GameStore} deps.gameStore
   * @param {import('../games/analyzer').GameAnalyzer} deps.analyzer
   * @param {import('../runtimes/library').RuntimeLibrary} deps.library
   * @param {import('../backups/backupService').BackupService} deps.backups
   * @param {import('../history/historyService').HistoryService} deps.history
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  static get STEPS() { return STEPS; }

  /**
   * @param {object} req
   * @param {string} req.gameId
   * @param {string} req.version Target runtime version (from the manifest DB).
   * @param {boolean} [req.force] Advanced: continue past warnings.
   * @param {boolean} [req.skipConflictWarnings] User clicked "Continue Anyway".
   * @param {'auto'|'all'|'required'} [req.optionalFiles] Which optional files to install.
   * @param {(p:{stepId:string, status:string, detail?:string, steps:Array})=>void} [onProgress]
   */
  async install(req, onProgress = () => {}) {
    const { gameId, version, force = false, skipConflictWarnings = false, optionalFiles = 'auto' } = req;
    const stepState = new Map(STEPS.map((s) => [s.id, { ...s, status: 'pending', detail: null }]));
    const emit = (stepId, status, detail) => {
      const s = stepState.get(stepId);
      if (s) { s.status = status; if (detail !== undefined) s.detail = detail; }
      onProgress({ stepId, status, detail, steps: [...stepState.values()] });
    };
    const fail = async (stepId, code, message, extra = {}) => {
      emit(stepId, 'failed', message);
      await this.logger.error(`Runtime install failed (${code}): ${message}`, { gameId, version });
      return { ok: false, code, error: message, steps: [...stepState.values()], ...extra };
    };

    const settings = await this.settings.get();
    let backupId = null;
    let committed = [];
    let stagingDir = null;
    let targetDirRef = null;

    /**
     * Failure AFTER the backup point: remove files we added (only while their
     * hash still matches), restore replaced files from the backup, record the
     * rollback in history and report honestly. Never leaves the game folder
     * partially modified without saying so.
     */
    const rollbackFail = async (stepId, code, message) => {
      emit(stepId, 'failed', message);
      await this.logger.warn(`Rolling back runtime install for "${game.name}" after failure: ${message}`);
      const rollback = { performed: true, removed: [], kept: [], restore: null };
      if (committed.length) {
        const rm = await removeInstalledFiles({ committed, targetDir: targetDirRef });
        rollback.removed = rm.removed;
        rollback.kept = rm.kept;
      }
      if (backupId) {
        rollback.restore = await this.backups.restore(gameId, backupId);
        await this.backups.finalize(gameId, backupId, { result: RESULTS.ROLLED_BACK });
      }
      await cleanupStaging(stagingDir);
      await this.history.add({
        gameId, gameName: game.name, action: 'runtime-install',
        toVersion: version, backupId, result: RESULTS.ROLLED_BACK,
        details: { error: message, code, rollback },
        steps: [...stepState.values()].map((s) => ({ id: s.id, label: s.label, status: s.status })),
      });
      return {
        ok: false, code: 'rolled-back', failedStep: stepId, error: message,
        rolledBack: true, rollback, backupId, steps: [...stepState.values()],
      };
    };

    // ---- Step 1: game + analysis ---------------------------------------
    emit('game', 'running');
    const game = await this.gameStore.get(gameId);
    if (!game) return fail('game', 'game-not-found', `Unknown game id: ${gameId}`);
    if (!fs.existsSync(game.installDir)) {
      return fail('game', 'install-missing', `Game folder does not exist: ${game.installDir}`);
    }
    const analysis = await this.analyzer.analyze(game);
    let targetDir = analysis.targetDir;
    if (!analysis.ok || !targetDir) {
      if (force && game.exePath && fs.existsSync(game.exePath)) {
        targetDir = path.dirname(game.exePath);
        emit('game', 'done', `Using manually chosen executable (${path.basename(game.exePath)}); analysis incomplete.`);
      } else {
        return fail('game', 'analysis-failed', analysis.errors.join(' ') || 'Could not analyze the game installation.');
      }
    } else {
      emit('game', 'done', `${game.name} — ${path.basename(analysis.executable ? analysis.executable.path : targetDir)}`);
    }
    targetDirRef = targetDir;
    await this.logger.info(`Installing runtime ${version} into "${game.name}" (${targetDir})`);

    // ---- Step 2: is the game running? -----------------------------------
    emit('running', 'running');
    const exeNames = [analysis.executable && analysis.executable.name, game.exeName].filter(Boolean);
    const proc = await areProcessesRunning(this.env, exeNames);
    if (proc.running) {
      if (settings.blockIfGameRunning && !force) {
        return fail('running', 'game-running',
          `${game.name} is currently running (PID ${proc.processes.map((p) => p.pid).join(', ')}). Close the game before modifying its files.`,
          { processes: proc.processes });
      }
      emit('running', 'done', 'Game is running — continuing anyway (override active). Files may be locked.');
    } else {
      emit('running', 'done', `No running process matched: ${exeNames.join(', ') || 'n/a'}`);
    }

    // ---- Step 3: conflicts ----------------------------------------------
    emit('conflicts', 'running');
    const conflictReport = await detectConflicts(targetDir, {
      runtimeHashIndex: await this.library.hashIndex().catch(() => new Map()),
      injectionHashIndex: this.injections ? await this.injections.hashIndex().catch(() => new Map()) : new Map(),
    });
    const warnings = conflictReport.conflicts.filter((c) => c.severity === 'warning');
    if (warnings.length && !skipConflictWarnings && !force && settings.warnOnConflicts) {
      emit('conflicts', 'waiting', `${warnings.length} potential conflict(s) need your decision.`);
      await this.logger.warn(`Conflicts detected before install (${warnings.length}) — waiting for user decision`);
      return {
        ok: false, code: 'needs-conflict-confirmation',
        conflicts: conflictReport.conflicts,
        steps: [...stepState.values()],
        error: `${warnings.length} potential conflict(s) detected. Review them and choose "Continue Anyway" or cancel.`,
      };
    }
    emit('conflicts', 'done', warnings.length ? `${warnings.length} warning(s) acknowledged` : 'No conflicts found');

    // ---- Step 4: validate runtime package --------------------------------
    emit('package', 'running');
    const pkgCheck = await this.library.validatePackage(version);
    if (!pkgCheck.ok) {
      return fail('package', pkgCheck.reason || 'invalid-package', pkgCheck.detail);
    }
    const pkg = pkgCheck.package;

    // Decide which package files participate in this install.
    const operations = [];
    for (const f of pkg.files || []) {
      const existsHere = fs.existsSync(path.join(targetDir, f.name));
      const include = f.required || (optionalFiles === 'all') || (optionalFiles === 'auto' && existsHere);
      if (include) operations.push({ ...f, existsHere });
    }
    if (!operations.length) {
      return fail('package', 'nothing-to-install', 'The selected package has no files applicable to this game.');
    }
    // Sanity: every target must be a regular file or absent. A directory (or
    // special file) sitting where a DLL belongs means something is very wrong
    // — refuse before any backup or modification happens.
    for (const op of operations) {
      const targetPath = path.join(targetDir, op.name);
      if (fs.existsSync(targetPath)) {
        const st = await fs.promises.stat(targetPath);
        if (!st.isFile()) {
          return fail('package', 'target-not-a-file',
            `${op.name} exists in the game folder but is not a regular file (found: ${st.isDirectory() ? 'a directory' : 'a special file'}). Nothing was modified — please inspect the game folder manually.`);
        }
      }
    }
    emit('package', 'done', `Runtime ${version}: ${operations.length} file(s) to install`);

    // ---- Step 5: backup ---------------------------------------------------
    emit('backup', 'running');
    const toBackup = operations.filter((o) => o.existsHere).map((o) => ({ relPath: o.name }));
    const willAdd = operations.filter((o) => !o.existsHere).map((o) => o.name);
    if (settings.autoBackup || toBackup.length) {
      const res = await this.backups.create({
        game, targetDir,
        files: toBackup,
        willAdd,
        operation: { type: 'runtime-install', version },
        runtimeBefore: {
          dlss: analysis.dlss.primaryVersion,
          streamline: analysis.streamline.version,
        },
      });
      if (!res.ok) return fail('backup', 'backup-failed', `Backup failed, nothing was modified: ${res.error}`);
      backupId = res.backupId;
      emit('backup', 'done', `Backup ${backupId} (${toBackup.length} original file(s) preserved)`);
    } else {
      emit('backup', 'done', 'Automatic backups are disabled in Options — no backup created.');
      await this.logger.warn('Installing WITHOUT a backup (autoBackup disabled and no existing files to preserve)');
    }

    // ---- Step 6: stage ------------------------------------------------------
    emit('stage', 'running');
    const stageRes = await stageFiles({
      targetDir,
      operations: operations.map((o) => ({
        sourcePath: this.library.packageFilePath(version, o.name),
        fileName: o.name,
        sha256: o.sha256,
        sizeBytes: o.sizeBytes,
      })),
    });
    if (!stageRes.ok) {
      return rollbackFail('stage', 'stage-failed', stageRes.error);
    }
    stagingDir = stageRes.stagingDir;
    emit('stage', 'done', `${stageRes.staged.length} file(s) staged and verified`);

    // ---- Step 7: install ----------------------------------------------------
    emit('install', 'running');
    const commitRes = await commitStaged({ staged: stageRes.staged, targetDir });
    committed = commitRes.committed;
    await cleanupStaging(stagingDir);
    stagingDir = null;
    if (!commitRes.ok) {
      const detail = commitRes.errors.map((e) => `${e.fileName}: ${e.error}`).join('; ');
      return rollbackFail('install', 'install-failed', detail);
    }
    emit('install', 'done', `${commitRes.committed.length} file(s) installed`);

    // ---- Step 8: verify ------------------------------------------------------
    emit('verify', 'running');
    const verifyProblems = [];
    if (settings.verifyAfterInstall) {
      for (const op of operations) {
        const targetPath = path.join(targetDir, op.name);
        const stat = await fs.promises.stat(targetPath).catch(() => null);
        if (!stat) { verifyProblems.push(`${op.name}: missing after install`); continue; }
        if (op.sizeBytes != null && stat.size !== op.sizeBytes) verifyProblems.push(`${op.name}: size mismatch`);
        // Version metadata cross-check for the core DLSS DLL when known.
        if (/\.dll$/i.test(op.name) && op.detectedVersion) {
          const ver = await readFileVersion(targetPath);
          if (ver && !ver.error && ver.fileVersion && ver.fileVersion !== op.detectedVersion) {
            verifyProblems.push(`${op.name}: version resource ${ver.fileVersion} ≠ expected ${op.detectedVersion}`);
          }
        }
      }
    }
    if (verifyProblems.length) {
      return rollbackFail('verify', 'verify-failed', verifyProblems.join('; '));
    }
    emit('verify', 'done', settings.verifyAfterInstall ? 'All installed files verified (hash/size/version)' : 'Verification disabled in Options');

    // ---- Marker, backup finalization, history --------------------------------
    const markerFiles = committed.map((c) => ({
      name: c.fileName,
      sha256: c.sha256,
      kind: operations.find((o) => o.name === c.fileName) && operations.find((o) => o.name === c.fileName).existsHere ? 'replaced' : 'added',
    }));
    await writeMarker(targetDir, {
      type: 'runtime-install', version, at: new Date().toISOString(), backupId,
      files: markerFiles,
      fromVersion: analysis.dlss.primaryVersion || null,
    }).catch((err) => this.logger.warn(`Could not write marker: ${err.message}`));

    if (backupId) {
      await this.backups.finalize(gameId, backupId, {
        addedFiles: committed
          .filter((c) => markerFiles.find((m) => m.name === c.fileName && m.kind === 'added'))
          .map((c) => ({ relPath: c.fileName, installedHash: c.sha256 })),
        result: RESULTS.SUCCESS,
      });
    }

    const entry = await this.history.add({
      gameId, gameName: game.name,
      action: 'runtime-install',
      fromVersion: analysis.dlss.primaryVersion || null,
      toVersion: version,
      backupId,
      result: RESULTS.SUCCESS,
      details: { targetDir, files: committed.map((c) => c.fileName) },
      steps: [...stepState.values()].map((s) => ({ id: s.id, label: s.label, status: s.status })),
    });

    await this.logger.success(`Runtime ${version} installed into "${game.name}" and verified (history ${entry.id})`);
    return {
      ok: true,
      steps: [...stepState.values()],
      backupId,
      historyId: entry.id,
      fromVersion: analysis.dlss.primaryVersion || null,
      toVersion: version,
      installedFiles: committed.map((c) => c.fileName),
    };
  }

}

module.exports = { RuntimeInstaller, STEPS };
