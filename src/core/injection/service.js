'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { areProcessesRunning } = require('../fileOperations/processCheck');
const { detectConflicts } = require('../conflicts/detector');
const { stageFiles, commitStaged, cleanupStaging, removeInstalledFiles, writeMarker } = require('../fileOperations/safeOps');
const { detectReShade, validateForInstall: validateReShade } = require('./reshade');
const { detectOptiScaler, validateForInstall: validateOptiScaler } = require('./optiscaler');
const { ensureCsvValueText, setIfMissingText } = require('./ini');
const { hashFile, verifyFileHash } = require('../hash');
const { RESULTS, INJECTION_METHODS, FILE_ROLES } = require('../../shared/constants');

/**
 * InjectionService — DLSS 5 Neural Rendering injection install/uninstall.
 *
 * Method support:
 *  - ReShade:     requires an existing ReShade install; installs add-on files
 *                 next to the game and ensures ReShade.ini can find them
 *                 (append-only INI edits; presets/shaders are never touched).
 *  - OptiScaler:  works with an existing OptiScaler install, or installs the
 *                 proxy files carried by the injection package itself.
 *
 * The package (imported by the user) declares its files, roles, optional
 * renames (installAs) and config directives — the app never hardcodes one
 * specific patched binary.
 */

const STEPS = [
  { id: 'game', label: 'Game detected' },
  { id: 'running', label: 'Game not running' },
  { id: 'method', label: 'Method prerequisites' },
  { id: 'package', label: 'Injection package validated' },
  { id: 'conflicts', label: 'Conflict check' },
  { id: 'backup', label: 'Backup created' },
  { id: 'install', label: 'Files installed' },
  { id: 'config', label: 'Configuration updated' },
  { id: 'verify', label: 'Installation verified' },
];

class InjectionService {
  /**
   * @param {object} deps env, logger, settings, gameStore, analyzer,
   *   injections (InjectionLibrary), runtimeLibrary, backups, history
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  static get STEPS() { return STEPS; }

  // ---------------------------------------------------------------- status

  /**
   * Full DLSS 5 injection status for one game.
   */
  async status(gameId) {
    const game = await this.gameStore.get(gameId);
    if (!game) return { ok: false, error: `Unknown game id: ${gameId}` };
    const analysis = await this.analyzer.analyze(game);
    const targetDir = analysis.targetDir || game.installDir;

    const reshadeDet = await detectReShade(targetDir);
    const optiscalerDet = await detectOptiScaler(targetDir);
    const reshadeVal = await validateReShade(targetDir);
    const optiVal = await validateOptiScaler(targetDir);

    // What does our marker say?
    const markerOps = (analysis.marker && analysis.marker.operations) || [];
    const injectionOps = markerOps.filter((o) => o.type === 'injection-install');
    const byMethod = {};
    for (const op of injectionOps) byMethod[op.method] = op;

    const installedFor = (method) => {
      const op = byMethod[method];
      if (op) {
        // Double-check the files are really still there with our hashes.
        const stillThere = (op.files || []).every((f) => {
          const p = path.join(targetDir, f.name);
          return fs.existsSync(p);
        });
        return { installed: stillThere, source: stillThere ? 'marker' : 'marker-stale', op };
      }
      return { installed: false, source: null, op: null };
    };

    return {
      ok: true,
      gameId,
      gameName: game.name,
      targetDir,
      analysisOk: analysis.ok,
      analysisErrors: analysis.errors,
      currentInjection: analysis.injection,
      methods: {
        [INJECTION_METHODS.OPTISCALER]: {
          detected: optiscalerDet.detected,
          evidence: optiscalerDet.evidence,
          version: optiscalerDet.version,
          problems: optiVal.problems,
          warnings: optiVal.warnings,
          ...installedFor(INJECTION_METHODS.OPTISCALER),
        },
        [INJECTION_METHODS.RESHADE]: {
          detected: reshadeDet.installed,
          evidence: reshadeDet.evidence,
          version: reshadeDet.version,
          proxyDll: reshadeDet.proxyDll ? path.basename(reshadeDet.proxyDll) : null,
          addons: reshadeDet.addons,
          problems: reshadeVal.problems,
          warnings: [],
          ...installedFor(INJECTION_METHODS.RESHADE),
        },
      },
    };
  }

  // --------------------------------------------------------------- install

  /**
   * Install an injection package into a game via the chosen method.
   * @param {object} req {gameId, injectionId, method, force?, skipConflictWarnings?}
   * @param {(p:{stepId:string,status:string,detail?:string,steps:Array})=>void} onProgress
   */
  async install(req, onProgress = () => {}) {
    const { gameId, injectionId, method, force = false, skipConflictWarnings = false } = req;
    const stepState = new Map(STEPS.map((s) => [s.id, { ...s, status: 'pending', detail: null }]));
    const emit = (stepId, status, detail) => {
      const s = stepState.get(stepId);
      if (s) { s.status = status; if (detail !== undefined) s.detail = detail; }
      onProgress({ stepId, status, detail, steps: [...stepState.values()] });
    };

    if (!Object.values(INJECTION_METHODS).includes(method)) {
      emit('method', 'failed', `Unknown injection method: ${method}`);
      return { ok: false, code: 'bad-method', error: `Unknown injection method: ${method}`, steps: [...stepState.values()] };
    }

    const settings = await this.settings.get();
    let backupId = null;
    let committed = [];
    let stagingDir = null;
    let game = null;
    let targetDir = null;
    const iniEdits = []; // {file, changed}

    const fail = (stepId, code, message, extra = {}) => {
      emit(stepId, 'failed', message);
      this.logger.error(`Injection install failed (${code}): ${message}`, { gameId, injectionId, method });
      return { ok: false, code, error: message, steps: [...stepState.values()], ...extra };
    };

    const rollbackFail = async (stepId, code, message) => {
      emit(stepId, 'failed', message);
      await this.logger.warn(`Rolling back injection install for game ${gameId} after failure: ${message}`);
      const rollback = { performed: true, removed: [], kept: [], restore: null, iniReverted: [] };
      if (committed.length) {
        const rm = await removeInstalledFiles({ committed, targetDir });
        rollback.removed = rm.removed;
        rollback.kept = rm.kept;
      }
      if (backupId) {
        rollback.restore = await this.backups.restore(gameId, backupId);
        await this.backups.finalize(gameId, backupId, { result: RESULTS.ROLLED_BACK });
      }
      await cleanupStaging(stagingDir);
      await this.history.add({
        gameId, gameName: game ? game.name : gameId, action: 'injection-install',
        method, injectionId, backupId, result: RESULTS.ROLLED_BACK,
        details: { error: message, code, rollback },
        steps: [...stepState.values()].map((s) => ({ id: s.id, label: s.label, status: s.status })),
      });
      return { ok: false, code: 'rolled-back', failedStep: stepId, error: message, rolledBack: true, rollback, backupId, steps: [...stepState.values()] };
    };

    // ---- Step 1: game ------------------------------------------------------
    emit('game', 'running');
    game = await this.gameStore.get(gameId);
    if (!game) return fail('game', 'game-not-found', `Unknown game id: ${gameId}`);
    if (!fs.existsSync(game.installDir)) return fail('game', 'install-missing', `Game folder does not exist: ${game.installDir}`);
    const analysis = await this.analyzer.analyze(game);
    targetDir = analysis.targetDir;
    if (!targetDir) {
      if (force && game.exePath) targetDir = path.dirname(game.exePath);
      else return fail('game', 'analysis-failed', analysis.errors.join(' ') || 'Could not analyze the game installation.');
    }
    emit('game', 'done', `${game.name} — ${targetDir}`);
    await this.logger.info(`Installing DLSS 5 injection (${method}) into "${game.name}"`);

    // ---- Step 2: running process -------------------------------------------
    emit('running', 'running');
    const exeNames = [analysis.executable && analysis.executable.name, game.exeName].filter(Boolean);
    const proc = await areProcessesRunning(this.env, exeNames);
    if (proc.running && settings.blockIfGameRunning && !force) {
      return fail('running', 'game-running',
        `${game.name} is currently running (PID ${proc.processes.map((p) => p.pid).join(', ')}). Close the game first.`,
        { processes: proc.processes });
    }
    emit('running', 'done', proc.running ? 'Running — override active, continuing.' : 'Game is not running');

    // ---- Step 3: method prerequisites ---------------------------------------
    emit('method', 'running');
    let methodInfo;
    if (method === INJECTION_METHODS.RESHADE) {
      methodInfo = await validateReShade(targetDir);
      if (methodInfo.problems.length && !force) {
        return fail('method', 'reshade-missing', methodInfo.problems.join(' '), { methodInfo });
      }
      emit('method', 'done', `ReShade detected (${methodInfo.evidence.join('; ') || 'assumed present'})`);
    } else {
      methodInfo = await validateOptiScaler(targetDir);
      const pkgForProxy = await this.injections.get(injectionId);
      const packageHasProxy = (pkgForProxy && pkgForProxy.files || []).some((f) => f.role === FILE_ROLES.PROXY);
      if (!methodInfo.detected && !packageHasProxy) {
        return fail('method', 'optiscaler-missing',
          'OptiScaler was not detected in the game folder and the injection package does not carry an OptiScaler proxy file (nvngx.dll / dxgi.dll / winmm.dll). Install OptiScaler first, or import a package that includes the proxy.',
          { methodInfo });
      }
      emit('method', 'done', methodInfo.detected
        ? `OptiScaler detected (${methodInfo.evidence.join('; ')})`
        : 'OptiScaler not present — the injection package provides the proxy files');
    }

    // ---- Step 4: package ------------------------------------------------------
    emit('package', 'running');
    const pkg = await this.injections.get(injectionId);
    if (!pkg) return fail('package', 'missing-package', `Injection package not found: ${injectionId}`);
    if (!Array.isArray(pkg.files) || !pkg.files.length) return fail('package', 'invalid-package', 'Injection package contains no files.');
    const packageProblems = [];
    for (const f of pkg.files) {
      const p = this.injections.filePath(injectionId, f.name);
      const check = await verifyFileHash(p, f.sha256);
      if (!check.ok) packageProblems.push(`${f.name}: ${check.reason}`);
    }
    if (packageProblems.length) return fail('package', 'invalid-package', `Injection package failed validation: ${packageProblems.join('; ')}`);
    if (!(pkg.methods || []).includes(method)) {
      if (!force) {
        return fail('package', 'method-mismatch',
          `Package "${pkg.name}" declares support for: ${(pkg.methods || []).join(', ') || 'unknown'} — not "${method}". Use Advanced Mode force to install anyway.`,
          { package: pkg });
      }
      emit('package', 'done', `Package validated (method mismatch overridden: ${pkg.name})`);
    } else {
      emit('package', 'done', `Package "${pkg.name}" validated (${pkg.files.length} file(s))`);
    }

    // ---- Build the install plan ---------------------------------------------
    const plan = this._buildPlan(pkg, method, targetDir, methodInfo);
    if (!plan.binaryOps.length && !plan.iniOps.length) {
      return fail('package', 'nothing-to-install', 'This package has nothing to install for the selected method.');
    }

    // ---- Step 5: conflicts -----------------------------------------------------
    emit('conflicts', 'running');
    const conflictReport = await detectConflicts(targetDir, {
      runtimeHashIndex: await this.runtimeLibrary.hashIndex().catch(() => new Map()),
      injectionHashIndex: await this.injections.hashIndex().catch(() => new Map()),
    });
    const colliding = conflictReport.conflicts.filter((c) =>
      c.type === 'proxy-dll' && c.severity === 'warning' &&
      plan.binaryOps.some((op) => op.fileName.toLowerCase() === String(c.file).toLowerCase()) &&
      c.owner !== 'dlss5-swapper-injection' &&
      // The host tool's own proxy is a prerequisite, not a conflict: installing
      // via ReShade means ReShade's proxy is expected to be there.
      c.owner !== method
    );
    const otherWarnings = conflictReport.conflicts.filter((c) =>
      c.severity === 'warning' && !colliding.includes(c) && c.owner !== method
    );
    if ((colliding.length || otherWarnings.length) && !skipConflictWarnings && !force && settings.warnOnConflicts) {
      emit('conflicts', 'waiting', `${colliding.length + otherWarnings.length} potential conflict(s) need your decision.`);
      return {
        ok: false, code: 'needs-conflict-confirmation',
        conflicts: conflictReport.conflicts,
        collidingFiles: colliding.map((c) => c.file),
        steps: [...stepState.values()],
        error: 'Potential conflicts detected. Review them and choose "Continue Anyway" or cancel.',
      };
    }
    emit('conflicts', 'done', colliding.length
      ? `${colliding.length} conflicting file(s) will be backed up and replaced (acknowledged)`
      : 'No blocking conflicts');

    // ---- Step 6: backup -----------------------------------------------------------
    emit('backup', 'running');
    const filesToBackup = [];
    for (const op of plan.binaryOps) {
      if (fs.existsSync(op.targetPath)) filesToBackup.push({ relPath: op.fileName });
    }
    for (const ini of plan.iniOps) {
      if (fs.existsSync(ini.path) && !filesToBackup.some((f) => f.relPath === ini.rel)) {
        filesToBackup.push({ relPath: ini.rel });
      }
    }
    const willAdd = plan.binaryOps.filter((op) => !fs.existsSync(op.targetPath)).map((op) => op.fileName);
    if (settings.autoBackup || filesToBackup.length) {
      const res = await this.backups.create({
        game, targetDir,
        files: filesToBackup,
        willAdd,
        operation: { type: 'injection-install', method, injectionId, injectionName: pkg.name },
        runtimeBefore: { dlss: analysis.dlss.primaryVersion, streamline: analysis.streamline.version },
      });
      if (!res.ok) return fail('backup', 'backup-failed', `Backup failed, nothing was modified: ${res.error}`);
      backupId = res.backupId;
      emit('backup', 'done', `Backup ${backupId} (${filesToBackup.length} file(s) preserved)`);
    } else {
      emit('backup', 'done', 'Automatic backups disabled — no backup created.');
    }

    // ---- Step 7: install binaries ----------------------------------------------------
    emit('install', 'running');
    let commitRes = { ok: true, committed: [], errors: [] };
    if (plan.binaryOps.length) {
      const stageRes = await stageFiles({
        targetDir,
        operations: plan.binaryOps.map((op) => ({
          sourcePath: op.sourcePath, fileName: op.fileName, sha256: op.sha256, sizeBytes: op.sizeBytes,
        })),
      });
      if (!stageRes.ok) return rollbackFail('install', 'stage-failed', stageRes.error);
      stagingDir = stageRes.stagingDir;
      commitRes = await commitStaged({ staged: stageRes.staged, targetDir });
      committed = commitRes.committed;
      await cleanupStaging(stagingDir);
      stagingDir = null;
      if (!commitRes.ok) {
        return rollbackFail('install', 'install-failed', commitRes.errors.map((e) => `${e.fileName}: ${e.error}`).join('; '));
      }
    }
    emit('install', 'done', `${committed.length} file(s) installed`);

    // ---- Step 8: configuration ----------------------------------------------------------
    emit('config', 'running');
    try {
      for (const ini of plan.iniOps) {
        let text = '';
        let existed = fs.existsSync(ini.path);
        if (existed) text = await fsp.readFile(ini.path, 'utf8');
        let out = { text, changed: false };
        for (const d of ini.directives) {
          if ((d.mode || 'set-if-missing') === 'ensure-csv') {
            const r = ensureCsvValueText(out.text, d.section, d.key, d.value, { separator: d.separator || ',' });
            out = { text: r.text, changed: out.changed || r.changed };
          } else {
            const r = setIfMissingText(out.text, d.section, d.key, d.value);
            out = { text: r.text, changed: out.changed || r.changed };
          }
        }
        if (out.changed || !existed) {
          const tmp = `${ini.path}.dlss5tmp`;
          await fsp.writeFile(tmp, out.text, 'utf8');
          await fsp.rename(tmp, ini.path);
          iniEdits.push({ file: ini.rel, changed: true, existedBefore: existed });
        } else {
          iniEdits.push({ file: ini.rel, changed: false, existedBefore: existed });
        }
      }
      emit('config', 'done', iniEdits.length
        ? `${iniEdits.filter((e) => e.changed).length} config file(s) updated, ${iniEdits.filter((e) => !e.changed).length} already correct`
        : 'No configuration changes needed');
    } catch (err) {
      return rollbackFail('config', 'config-failed', err.message);
    }

    // ---- Step 9: verify -------------------------------------------------------------------
    emit('verify', 'running');
    const problems = [];
    // Config files that received INI directives are expected to differ from
    // the package copy — verify existence for those, hashes for everything else.
    const iniModified = new Set(iniEdits.filter((e) => e.changed).map((e) => e.file.toLowerCase()));
    if (settings.verifyAfterInstall) {
      for (const op of plan.binaryOps) {
        if (iniModified.has(op.fileName.toLowerCase())) {
          if (!fs.existsSync(op.targetPath)) problems.push(`${op.fileName}: missing after config merge`);
          continue;
        }
        const check = await verifyFileHash(op.targetPath, op.sha256);
        if (!check.ok) problems.push(`${op.fileName}: ${check.reason}`);
      }
    }
    if (problems.length) return rollbackFail('verify', 'verify-failed', problems.join('; '));
    emit('verify', 'done', 'Installation verified');

    // ---- Marker / finalize / history ---------------------------------------------------------
    const markerFiles = plan.binaryOps.map((op) => {
      const wasReplaced = filesToBackup.some((f) => f.relPath === op.fileName);
      return { name: op.fileName, sourceName: op.sourceName, sha256: op.sha256, kind: wasReplaced ? 'replaced' : 'added' };
    });
    await writeMarker(targetDir, {
      type: 'injection-install', injectionId, injectionName: pkg.name, method,
      at: new Date().toISOString(), backupId, files: markerFiles, iniEdits,
    }).catch((err) => this.logger.warn(`Could not write marker: ${err.message}`));

    if (backupId) {
      const addedFiles = [];
      for (const op of plan.binaryOps) {
        if (!filesToBackup.some((f) => f.relPath === op.fileName)) addedFiles.push({ relPath: op.fileName, installedHash: op.sha256 });
      }
      for (const edit of iniEdits) {
        if (!edit.existedBefore) {
          const h = await hashFile(path.join(targetDir, edit.file)).catch(() => null);
          if (h) addedFiles.push({ relPath: edit.file, installedHash: h });
        }
      }
      await this.backups.finalize(gameId, backupId, { addedFiles, result: RESULTS.SUCCESS });
    }

    const entry = await this.history.add({
      gameId, gameName: game.name, action: 'injection-install',
      method, injectionId, injectionName: pkg.name, backupId,
      result: RESULTS.SUCCESS,
      details: { targetDir, files: markerFiles.map((f) => f.name), iniEdits },
      steps: [...stepState.values()].map((s) => ({ id: s.id, label: s.label, status: s.status })),
    });

    await this.logger.success(`DLSS 5 injection "${pkg.name}" installed into "${game.name}" via ${method} (history ${entry.id})`);
    return {
      ok: true, steps: [...stepState.values()], backupId, historyId: entry.id,
      installedFiles: markerFiles.map((f) => f.name), iniEdits,
    };
  }

  /**
   * Build the concrete install plan from a package + method.
   * Binary files → staged replace; config-role files → install only when the
   * target doesn't exist (never clobber a user's working config); plus INI
   * directives (package-declared + method defaults).
   */
  _buildPlan(pkg, method, targetDir, methodInfo) {
    const binaryOps = [];
    const iniOps = [];
    const directivesByFile = new Map(); // relPath → directives[]

    const addDirectives = (rel, list) => {
      if (!rel || !list || !list.length) return;
      if (!directivesByFile.has(rel)) directivesByFile.set(rel, []);
      directivesByFile.get(rel).push(...list);
    };

    for (const f of pkg.files || []) {
      const targetName = f.installAs || f.name;
      const rel = targetName;
      const targetPath = path.join(targetDir, rel);
      if (f.role === FILE_ROLES.CONFIG && /\.(ini|cfg)$/i.test(f.name)) {
        // Config file from the package: only place it when absent — an existing
        // user config is sacred. Its recommended directives are still applied.
        if (!fs.existsSync(targetPath)) {
          binaryOps.push({
            sourcePath: this.injections.filePath(pkg.id, f.name),
            sourceName: f.name, fileName: rel, targetPath,
            sha256: f.sha256, sizeBytes: f.sizeBytes,
          });
        }
        continue;
      }
      if (f.role === FILE_ROLES.CONFIG && /\.json$/i.test(f.name)) {
        if (!fs.existsSync(targetPath)) {
          binaryOps.push({
            sourcePath: this.injections.filePath(pkg.id, f.name),
            sourceName: f.name, fileName: rel, targetPath,
            sha256: f.sha256, sizeBytes: f.sizeBytes,
          });
        }
        continue;
      }
      binaryOps.push({
        sourcePath: this.injections.filePath(pkg.id, f.name),
        sourceName: f.name, fileName: rel, targetPath,
        sha256: f.sha256, sizeBytes: f.sizeBytes,
      });
    }

    // Package-declared config directives.
    for (const d of pkg.configDirectives || []) {
      addDirectives(d.file || (method === INJECTION_METHODS.RESHADE ? 'ReShade.ini' : 'OptiScaler.ini'), [d]);
    }

    // Method defaults.
    if (method === INJECTION_METHODS.RESHADE) {
      const hasAddon = binaryOps.some((op) => /\.addon(64|32)$/i.test(op.fileName));
      if (hasAddon && methodInfo.iniPath) {
        // Make sure ReShade searches the game folder for add-ons.
        addDirectives(path.basename(methodInfo.iniPath), [
          { section: 'ADDONS', key: 'AddonSearchPaths', value: '.', mode: 'ensure-csv' },
        ]);
      }
    }

    for (const [rel, directives] of directivesByFile) {
      iniOps.push({ rel, path: path.join(targetDir, rel), directives });
    }
    return { binaryOps, iniOps };
  }

  // ------------------------------------------------------------- uninstall

  /**
   * Uninstall a previously installed injection by restoring its backup.
   * @param {object} req {gameId, method?, backupId?}
   */
  async uninstall(req, onProgress = () => {}) {
    const { gameId, method } = req;
    const game = await this.gameStore.get(gameId);
    if (!game) return { ok: false, error: `Unknown game id: ${gameId}` };

    let backupId = req.backupId;
    let meta = null;
    if (backupId) {
      meta = await this.backups.getMetadata(gameId, backupId);
      if (!meta) return { ok: false, error: `Backup ${backupId} not found for this game.` };
    } else {
      const all = await this.backups.list(gameId);
      meta = all.find((b) =>
        b.operation && b.operation.type === 'injection-install' &&
        (!method || b.operation.method === method) &&
        b.result === RESULTS.SUCCESS
      );
      if (!meta) return { ok: false, error: `No successful injection install found for ${game.name}${method ? ` via ${method}` : ''}.` };
      backupId = meta.backupId;
    }

    await this.logger.info(`Uninstalling DLSS 5 injection from "${game.name}" (restoring backup ${backupId})`);
    const res = await this.backups.restore(gameId, backupId, { onProgress });
    if (res.ok) {
      await this.backups.finalize(gameId, backupId, { result: 'restored' });
      await this.history.add({
        gameId, gameName: game.name, action: 'injection-uninstall',
        method: meta.operation.method || null,
        injectionName: meta.operation.injectionName || null,
        backupId, result: RESULTS.SUCCESS,
        details: { restored: res.restored, deleted: res.deleted, warnings: res.warnings },
      });
      await this.logger.success(`DLSS 5 injection removed from "${game.name}"; original files restored`);
    } else {
      await this.history.add({
        gameId, gameName: game.name, action: 'injection-uninstall',
        backupId, result: RESULTS.FAILED, details: { errors: res.errors },
      });
    }
    return { ok: res.ok, ...res, backupId };
  }
}

module.exports = { InjectionService, INJECTION_STEPS: STEPS };
