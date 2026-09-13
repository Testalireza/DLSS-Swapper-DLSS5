'use strict';

/**
 * UMD module — loaded by Node (core/tests) AND directly in the renderer via
 * a <script> tag (browser preview + Electron), so both worlds share one
 * source of truth.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DLSS5Shared = Object.assign({}, root.DLSS5Shared, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {

/**
 * Shared constants used by both the main process (core services) and the
 * renderer. Kept dependency-free so they can be imported anywhere.
 */

const APP = Object.freeze({
  name: 'DLSS Swapper 5',
  shortName: 'DLSS5 Swapper',
  version: '1.0.0',
  repository: 'https://github.com/Testalireza/DLSS-Swapper-DLSS5',
  license: 'MIT',
  dataDirEnvVar: 'DLSS5SWAPPER_DATA',
  /** Marker file dropped into folders this app modifies, for traceability. */
  markerFileName: '.dlss5swapper-marker.json',
});

/**
 * IPC channel names. Every renderer<->main conversation goes through one of
 * these channels; the same map powers the browser dev-preview server.
 */
const IPC = Object.freeze({
  // app
  APP_INFO: 'app:info',
  APP_CHECK_UPDATE: 'app:checkUpdate',
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_OPEN_DATA_DIR: 'settings:openDataDir',
  // logs
  LOGS_RECENT: 'logs:recent',
  LOGS_EXPORT: 'logs:export',
  LOGS_OPEN_FOLDER: 'logs:openFolder',
  // games
  GAMES_SCAN: 'games:scan',
  GAMES_SCAN_PROGRESS: 'games:scanProgress',
  GAMES_LIST: 'games:list',
  GAMES_ANALYZE: 'games:analyze',
  GAMES_ADD_MANUAL: 'games:addManual',
  GAMES_REMOVE: 'games:remove',
  GAMES_IGNORE: 'games:ignore',
  GAMES_CHOOSE_EXE: 'games:chooseExecutable',
  GAMES_IS_RUNNING: 'games:isRunning',
  // runtimes
  RUNTIMES_LIST: 'runtimes:list',
  RUNTIMES_IMPORT: 'runtimes:import',
  RUNTIMES_DELETE: 'runtimes:delete',
  RUNTIMES_DOWNLOAD: 'runtimes:download',
  RUNTIMES_DOWNLOAD_PROGRESS: 'runtimes:downloadProgress',
  RUNTIMES_OPEN_LIBRARY: 'runtimes:openLibrary',
  // operations
  OPS_CHECK_CONFLICTS: 'ops:checkConflicts',
  OPS_INSTALL_RUNTIME: 'ops:installRuntime',
  OPS_PROGRESS: 'ops:progress',
  // backups
  BACKUPS_LIST: 'backups:list',
  BACKUPS_GET: 'backups:get',
  BACKUPS_RESTORE: 'backups:restore',
  BACKUPS_DELETE: 'backups:delete',
  BACKUPS_OPEN_FOLDER: 'backups:openFolder',
  // injections (DLSS 5 Neural Rendering)
  INJECTIONS_LIST: 'injections:list',
  INJECTIONS_IMPORT: 'injections:import',
  INJECTIONS_DELETE: 'injections:delete',
  INJECTIONS_UPDATE: 'injections:update',
  INJECTIONS_STATUS: 'injections:status',
  INJECTIONS_INSTALL: 'injections:install',
  INJECTIONS_UNINSTALL: 'injections:uninstall',
  // gpu
  GPU_INFO: 'gpu:info',
  // history
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  // filesystem helpers (native dialogs under Electron)
  FS_PICK_FOLDER: 'fs:pickFolder',
  FS_PICK_FILES: 'fs:pickFiles',
  FS_OPEN_PATH: 'fs:openPath',
  FS_SHOW_ITEM: 'fs:showItem',
});

/**
 * Graphics proxy DLL names commonly dropped next to a game executable by
 * modding tools (ReShade, OptiScaler, Special K, dgVoodoo, ...). Used by the
 * conflict detector and by injection method detection.
 */
const PROXY_DLLS = Object.freeze([
  'dxgi.dll',
  'd3d8.dll',
  'd3d9.dll',
  'd3d11.dll',
  'd3d12.dll',
  'ddraw.dll',
  'winmm.dll',
  'version.dll',
  'opengl32.dll',
  'vulkan-1.dll',
]);

/**
 * NVIDIA Streamline / DLSS related file names we recognise inside game
 * folders. Order matters: first match wins when classifying a file.
 */
const DLSS_FILES = Object.freeze({
  /** Core DLSS upscaler runtime. */
  dlss: ['nvngx_dlss.dll'],
  /** DLSS-G frame generation runtime. */
  dlssg: ['nvngx_dlssg.dll'],
  /** DLSS-D ray reconstruction runtime. */
  dlssd: ['nvngx_dlssd.dll'],
  /** Legacy loader shim shipped by some games. */
  nvngx: ['nvngx.dll'],
});

/** Streamline plugin DLL naming pattern (sl.<plugin>.dll). */
const STREAMLINE_PLUGIN_PATTERN = /^sl\.[a-z0-9_]+\.(dll|json)$/i;

/** Roles a file inside a runtime/injection package can have. */
const FILE_ROLES = Object.freeze({
  DLSS_CORE: 'dlss-core',
  DLSS_FRAMEGEN: 'dlss-framegen',
  DLSS_RAYRECON: 'dlss-rayrecon',
  STREAMLINE_PLUGIN: 'streamline-plugin',
  STREAMLINE_CONFIG: 'streamline-config',
  INJECTION_CORE: 'injection-core',
  INJECTION_ADDON: 'injection-addon',
  PROXY: 'proxy',
  CONFIG: 'config',
  OTHER: 'other',
});

/** Injection methods supported by the DLSS 5 Neural Rendering section. */
const INJECTION_METHODS = Object.freeze({
  OPTISCALER: 'optiscaler',
  RESHADE: 'reshade',
});

/** Operation outcomes recorded in history. */
const RESULTS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled-back',
  CANCELLED: 'cancelled',
});

/** GPU architecture generations recognised for RTX compatibility. */
const NVIDIA_ARCHITECTURES = Object.freeze([
  { id: 'blackwell', name: 'Blackwell', series: 'RTX 50', minComputeCapability: 12.0 },
  { id: 'ada', name: 'Ada Lovelace', series: 'RTX 40', minComputeCapability: 8.9 },
  { id: 'ampere', name: 'Ampere', series: 'RTX 30', minComputeCapability: 8.0 },
  { id: 'turing', name: 'Turing', series: 'RTX 20 / GTX 16', minComputeCapability: 7.5 },
  { id: 'pascal', name: 'Pascal', series: 'GTX 10', minComputeCapability: 6.1 },
  { id: 'maxwell', name: 'Maxwell', series: 'GTX 900', minComputeCapability: 5.0 },
]);

/** Lowest CUDA compute capability that has Tensor Cores (DLSS capable). */
const MIN_DLSS_COMPUTE_CAPABILITY = 7.5;


return {

  APP,
  IPC,
  PROXY_DLLS,
  DLSS_FILES,
  STREAMLINE_PLUGIN_PATTERN,
  FILE_ROLES,
  INJECTION_METHODS,
  RESULTS,
  NVIDIA_ARCHITECTURES,
  MIN_DLSS_COMPUTE_CAPABILITY,

};
});
