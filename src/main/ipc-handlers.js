'use strict';

const path = require('path');
const { IPC, APP } = require('../shared/constants');
const { checkForUpdate } = require('../core/updates/updater');
const { areProcessesRunning } = require('../core/fileOperations/processCheck');
const { detectConflicts } = require('../core/conflicts/detector');

/**
 * IPC handler registry.
 *
 * One map of channel → async handler used by BOTH transports:
 *   - Electron: ipcMain.handle(channel, (e, payload) => run(channel, payload, ctx))
 *   - Browser dev preview: HTTP POST /ipc {channel, payload} → run(...)
 *
 * `hooks` abstracts the desktop-only capabilities (native dialogs, opening
 * folders). The web server supplies graceful browser-mode implementations, so
 * the renderer code path is identical in both environments.
 *
 * @param {ReturnType<import('../core/app-services').createServices>} services
 * @param {object} hooks
 * @param {boolean} hooks.isElectron
 * @param {(p:string)=>Promise<{ok:boolean}>} hooks.openPath
 * @param {(p:string)=>Promise<{ok:boolean}>} hooks.showItemInFolder
 * @param {()=>Promise<{canceled:boolean, filePaths?:string[]}>} hooks.pickFolder
 * @param {(opts:{multiple?:boolean, filters?:Array})=>Promise<{canceled:boolean, filePaths?:string[]}>} hooks.pickFiles
 * @param {(opts:{defaultPath?:string})=>Promise<{canceled:boolean, filePath?:string}>} hooks.pickSaveFile
 */
function createIpcHandlers(services, hooks) {
  const {
    env, settings, logger, manifests, runtimeLibrary, providers, gameStore,
    analyzer, injectionLibrary, injectionService, backups, history, gpu,
    runtimeInstaller,
  } = services;

  const requireGame = async (gameId) => {
    const game = await gameStore.get(gameId);
    if (!game) throw new Error(`Unknown game id: ${gameId}. Try re-scanning your library.`);
    return game;
  };

  const handlers = {
    // ---------------------------------------------------------------- app
    [IPC.APP_INFO]: async () => ({
      name: APP.name,
      version: APP.version,
      repository: APP.repository,
      license: APP.license,
      platform: env.platform,
      dataDir: env.dataDir,
      resourcesDir: env.resourcesDir,
      electron: !!hooks.isElectron,
    }),

    [IPC.APP_CHECK_UPDATE]: async () => checkForUpdate({ env, settings, logger }),

    // ----------------------------------------------------------- settings
    [IPC.SETTINGS_GET]: async () => settings.get(),
    [IPC.SETTINGS_SET]: async (p) => ({ ok: true, settings: await settings.set(p && p.patch) }),
    [IPC.SETTINGS_RESET]: async () => ({ ok: true, settings: await settings.reset() }),
    [IPC.SETTINGS_OPEN_DATA_DIR]: async () => hooks.openPath(env.dataDir),

    // --------------------------------------------------------------- logs
    [IPC.LOGS_RECENT]: async (p) => logger.recent((p && p.limit) || 200),
    [IPC.LOGS_EXPORT]: async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const pick = await hooks.pickSaveFile({ defaultPath: `dlss-swapper-5-log-${stamp}.log` });
      if (!pick || pick.canceled || !pick.filePath) return { ok: false, canceled: true };
      const file = await logger.exportTo(pick.filePath);
      return { ok: true, file };
    },
    [IPC.LOGS_OPEN_FOLDER]: async () => hooks.openPath(env.paths.logs),

    // -------------------------------------------------------------- games
    [IPC.GAMES_SCAN]: async (p, ctx) =>
      gameStore.scan((prog) => ctx.emit(IPC.GAMES_SCAN_PROGRESS, prog)),

    [IPC.GAMES_LIST]: async () => gameStore.list(),

    [IPC.GAMES_ANALYZE]: async (p) => {
      const game = await requireGame(p.gameId);
      return analyzer.analyze(game);
    },

    [IPC.GAMES_ADD_MANUAL]: async (p) => {
      if (!p || !p.installDir) throw new Error('A game folder is required.');
      const id = await gameStore.addManual({ name: p.name, installDir: p.installDir, exePath: p.exePath });
      return { ok: true, id };
    },

    [IPC.GAMES_REMOVE]: async (p) => gameStore.removeManual(p.gameId),
    [IPC.GAMES_IGNORE]: async (p) => gameStore.setIgnored(p.gameId, !!p.ignored),
    [IPC.GAMES_CHOOSE_EXE]: async (p) => {
      await requireGame(p.gameId);
      return gameStore.chooseExecutable(p.gameId, p.exePath);
    },

    [IPC.GAMES_IS_RUNNING]: async (p) => {
      const game = await requireGame(p.gameId);
      const names = [game.exeName, p.exeName].filter(Boolean);
      return areProcessesRunning(env, names.length ? names : [path.basename(game.installDir)]);
    },

    // ----------------------------------------------------------- runtimes
    [IPC.RUNTIMES_LIST]: async () => ({
      runtimes: await runtimeLibrary.listAvailability(),
      loadErrors: manifests.loadErrors(),
      providers: providers.list(),
    }),

    [IPC.RUNTIMES_IMPORT]: async (p) => {
      let filePaths = p.filePaths;
      if (!filePaths || !filePaths.length) {
        const pick = await hooks.pickFiles({
          multiple: true,
          filters: [
            { name: 'Runtime files (*.dll, *.json)', extensions: ['dll', 'json'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths.length) return { ok: false, canceled: true };
        filePaths = pick.filePaths;
      }
      return runtimeLibrary.importPackage({
        version: p.version,
        filePaths,
        origin: p.origin || 'user-import',
        allowVersionMismatch: !!p.allowVersionMismatch,
      });
    },

    [IPC.RUNTIMES_DELETE]: async (p) => runtimeLibrary.deletePackage(p.version),

    [IPC.RUNTIMES_DOWNLOAD]: async (p, ctx) =>
      providers.download(p.version, p.providerIds, (prog) =>
        ctx.emit(IPC.RUNTIMES_DOWNLOAD_PROGRESS, { ...prog, version: p.version })),

    [IPC.RUNTIMES_OPEN_LIBRARY]: async () => hooks.openPath(env.paths.runtimeLibrary),

    // -------------------------------------------------------- operations
    [IPC.OPS_CHECK_CONFLICTS]: async (p) => {
      const game = await requireGame(p.gameId);
      const analysis = await analyzer.analyze(game);
      const targetDir = analysis.targetDir || game.installDir;
      return detectConflicts(targetDir, {
        runtimeHashIndex: await runtimeLibrary.hashIndex().catch(() => new Map()),
        injectionHashIndex: await injectionLibrary.hashIndex().catch(() => new Map()),
      });
    },

    [IPC.OPS_INSTALL_RUNTIME]: async (p, ctx) =>
      runtimeInstaller.install(
        { gameId: p.gameId, version: p.version, force: !!p.force, skipConflictWarnings: !!p.skipConflictWarnings, optionalFiles: p.optionalFiles || 'auto' },
        (prog) => ctx.emit(IPC.OPS_PROGRESS, { ...prog, op: 'runtime', gameId: p.gameId, version: p.version })
      ),

    // ------------------------------------------------------------ backups
    [IPC.BACKUPS_LIST]: async (p) => backups.list(p && p.gameId),

    [IPC.BACKUPS_GET]: async (p) => {
      const meta = await backups.getMetadata(p.gameId, p.backupId);
      if (!meta) throw new Error(`Backup ${p.backupId} not found.`);
      return meta;
    },

    [IPC.BACKUPS_RESTORE]: async (p, ctx) =>
      backups.restore(p.gameId, p.backupId, {
        dryRun: !!p.dryRun,
        onProgress: (prog) => ctx.emit(IPC.OPS_PROGRESS, { ...prog, op: 'restore', gameId: p.gameId, backupId: p.backupId }),
      }),

    [IPC.BACKUPS_DELETE]: async (p) => backups.delete(p.gameId, p.backupId),

    [IPC.BACKUPS_OPEN_FOLDER]: async (p) => {
      if (p && p.gameId && p.backupId) {
        const meta = await backups.getMetadata(p.gameId, p.backupId);
        if (meta) return hooks.showItemInFolder(meta.__dir);
      }
      return hooks.openPath(await backups.root());
    },

    // --------------------------------------------------------- injections
    [IPC.INJECTIONS_LIST]: async () => injectionLibrary.list(),

    [IPC.INJECTIONS_IMPORT]: async (p) => {
      let filePaths = p.filePaths;
      if (!filePaths || !filePaths.length) {
        const pick = await hooks.pickFiles({
          multiple: true,
          filters: [{ name: 'Injection files', extensions: ['dll', 'addon64', 'addon32', 'ini', 'json'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths.length) return { ok: false, canceled: true };
        filePaths = pick.filePaths;
      }
      return injectionLibrary.importPackage({ ...p, filePaths });
    },

    [IPC.INJECTIONS_DELETE]: async (p) => injectionLibrary.delete(p.id),
    [IPC.INJECTIONS_UPDATE]: async (p) => injectionLibrary.updatePackage(p.id, p.patch),

    [IPC.INJECTIONS_STATUS]: async (p) => injectionService.status(p.gameId),

    [IPC.INJECTIONS_INSTALL]: async (p, ctx) =>
      injectionService.install(
        { gameId: p.gameId, injectionId: p.injectionId, method: p.method, force: !!p.force, skipConflictWarnings: !!p.skipConflictWarnings },
        (prog) => ctx.emit(IPC.OPS_PROGRESS, { ...prog, op: 'injection', gameId: p.gameId, method: p.method })
      ),

    [IPC.INJECTIONS_UNINSTALL]: async (p, ctx) =>
      injectionService.uninstall(
        { gameId: p.gameId, method: p.method, backupId: p.backupId },
        (prog) => ctx.emit(IPC.OPS_PROGRESS, { ...prog, op: 'injection-uninstall', gameId: p.gameId })
      ),

    // ---------------------------------------------------------------- gpu
    [IPC.GPU_INFO]: async (p) => gpu.getInfo(!!(p && p.refresh)),

    // ------------------------------------------------------------ history
    [IPC.HISTORY_LIST]: async (p) => history.list((p && p.limit) || 100, p && p.gameId),
    [IPC.HISTORY_GET]: async (p) => history.get(p.id),

    // ----------------------------------------------------------------- fs
    [IPC.FS_PICK_FOLDER]: async () => hooks.pickFolder(),
    [IPC.FS_PICK_FILES]: async (p) => hooks.pickFiles(p || {}),
    [IPC.FS_OPEN_PATH]: async (p) => hooks.openPath(p.path),
    [IPC.FS_SHOW_ITEM]: async (p) => hooks.showItemInFolder(p.path),
  };

  return handlers;
}

/**
 * Wrap handlers so thrown errors become structured results instead of
 * crashing a transport. Advanced mode surfaces the stack; normal mode shows
 * the friendly message only.
 */
function wrapHandler(fn, logger) {
  return async (payload, ctx) => {
    try {
      return await fn(payload || {}, ctx || { emit() {} });
    } catch (err) {
      if (logger) await logger.errorObj('IPC handler error', err);
      return { ok: false, error: err.message || String(err), stack: err.stack || null };
    }
  };
}

function wrapAll(handlers, logger) {
  const out = {};
  for (const [channel, fn] of Object.entries(handlers)) out[channel] = wrapHandler(fn, logger);
  return out;
}

module.exports = { createIpcHandlers, wrapAll, wrapHandler };
