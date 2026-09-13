'use strict';

const { SettingsService } = require('./settings');
const { Logger } = require('./logger');
const { ManifestStore } = require('./runtimes/manifests');
const { RuntimeLibrary } = require('./runtimes/library');
const { ProviderRegistry } = require('./runtimes/providers');
const { GameStore } = require('./games/gameStore');
const { GameAnalyzer } = require('./games/analyzer');
const { InjectionLibrary } = require('./injection/library');
const { InjectionService } = require('./injection/service');
const { BackupService } = require('./backups/backupService');
const { HistoryService } = require('./history/historyService');
const { GpuService } = require('./compatibility/gpuInfo');
const { RuntimeInstaller } = require('./ops/installRuntime');

/**
 * Composition root — poor-man's dependency injection.
 *
 * Every service is constructed once with explicit dependencies (interfaces by
 * duck-typing: anything with the same shape works, which is what the tests
 * exploit). No service reaches into globals; the AppEnv carries paths,
 * platform and the command runner.
 */
function createServices({ env }) {
  const settings = new SettingsService(env);
  const logger = new Logger(env, settings);
  const manifests = new ManifestStore(env, logger);
  const runtimeLibrary = new RuntimeLibrary(env, logger, manifests);
  const providers = new ProviderRegistry(env, logger, runtimeLibrary, manifests, settings);
  const gameStore = new GameStore(env, logger, settings);
  const injectionLibrary = new InjectionLibrary(env, logger);
  const analyzer = new GameAnalyzer(env, logger, runtimeLibrary, injectionLibrary);
  const backups = new BackupService(env, logger, settings);
  const history = new HistoryService(env, logger);
  const gpu = new GpuService(env, logger, settings);
  const runtimeInstaller = new RuntimeInstaller({
    env, logger, settings, gameStore, analyzer,
    library: runtimeLibrary, injections: injectionLibrary, backups, history,
  });
  const injectionService = new InjectionService({
    env, logger, settings, gameStore, analyzer,
    injections: injectionLibrary, runtimeLibrary, backups, history,
  });

  return {
    env,
    settings,
    logger,
    manifests,
    runtimeLibrary,
    providers,
    gameStore,
    analyzer,
    injectionLibrary,
    injectionService,
    backups,
    history,
    gpu,
    runtimeInstaller,
  };
}

module.exports = { createServices };
