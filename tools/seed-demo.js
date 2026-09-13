'use strict';

/**
 * seed-demo.js — builds a fully populated demo environment so the UI (web
 * preview or desktop app) can be explored end-to-end with REAL artifacts:
 *
 *   • three synthetic games on disk (valid PE executables with import tables,
 *     DLSS + Streamline DLLs with real version resources; one ships ReShade)
 *   • game library filled by the real folder scanner
 *   • runtime library with three imported+hashed packages (310.6.0/310.8.1/310.9.1)
 *   • two completed runtime installs (backup → verify → history)
 *   • one OptiScaler and one ReShade injection package, both installed
 *   • GPU panel reporting an RTX 4070 via a stubbed nvidia-smi
 *
 * Everything is produced by the app's own services — nothing is faked in the
 * database; the files, hashes, backups, markers and history are genuine.
 *
 * Usage:
 *   npm run seed-demo                 # seed ./dlss5swapper-data (repo, gitignored)
 *   npm run seed-demo -- --reset      # wipe the demo data dir first
 *   DLSS5SWAPPER_DATA=/tmp/x npm run seed-demo -- --force   # seed a custom dir
 *
 * Then:  npm run webdev   →  http://localhost:8123
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const REPO = path.join(__dirname, '..');
const { AppEnv } = require(path.join(REPO, 'src', 'core', 'env'));
const { createServices } = require(path.join(REPO, 'src', 'core', 'app-services'));
const { buildPeDll } = require(path.join(REPO, 'src', 'core', 'pe', 'peBuilder'));
const {
  fakeRunner, makeFakeGame, makeRuntimePackageFiles,
} = require(path.join(REPO, 'tests', 'helpers'));

const DEFAULT_DEMO_DIR = path.join(REPO, '.dlss5swapper-data');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function log(msg) { console.log(`  ${msg}`); }
function head(msg) { console.log(`\n▶ ${msg}`); }

async function main() {
  const dataDir = process.env.DLSS5SWAPPER_DATA || DEFAULT_DEMO_DIR;
  const isDefaultDir = path.resolve(dataDir) === path.resolve(DEFAULT_DEMO_DIR);

  if (!isDefaultDir && !has('--force')) {
    console.error(`Refusing to seed a custom data dir without --force: ${dataDir}`);
    process.exit(1);
  }

  const exists = fs.existsSync(path.join(dataDir, 'games.json')) ||
    fs.existsSync(path.join(dataDir, 'settings.json'));
  if (exists && !has('--reset')) {
    console.error(`Data dir already contains state: ${dataDir}\nRe-run with --reset to wipe it first (backups/history in it will be deleted).`);
    process.exit(1);
  }
  if (has('--reset')) {
    await fsp.rm(dataDir, { recursive: true, force: true });
    log(`wiped ${dataDir}`);
  }

  const gamesRoot = path.join(dataDir, 'demo-games');

  // Stubbed nvidia-smi so the GPU panel has a realistic, *classified* GPU.
  const runner = fakeRunner({
    'nvidia-smi': {
      stdout: 'NVIDIA GeForce RTX 4070, 580.65, 12288, 8.9\n',
      stderr: '',
      code: 0,
    },
  });

  const env = new AppEnv({
    dataDir,
    resourcesDir: path.join(REPO, 'resources'),
    platform: process.platform,
    runner,
    homeDir: dataDir,
    env: {},
  });
  await env.ensureDirs();
  const services = createServices({ env });
  const { gameStore, analyzer, runtimeLibrary, runtimeInstaller, injectionLibrary, injectionService, history, backups } = services;

  head('Scanning environment');
  log(`data dir:   ${dataDir}`);
  log(`demo games: ${gamesRoot}`);

  // ------------------------------------------------------------------ games
  head('Creating synthetic game installs (real PE binaries)');
  await fsp.rm(gamesRoot, { recursive: true, force: true });
  const games = [];
  games.push(await makeFakeGame(services, {
    name: 'Nebula Drift', exeName: 'NebulaDrift.exe', root: path.join(gamesRoot, 'Nebula Drift'),
    imports: ['kernel32.dll', 'd3d12.dll', 'dxgi.dll'],
    dlssVersion: '310.6.0', streamlineVersion: '2.11.140',
  }));
  log('Nebula Drift   — DirectX 12, DLSS 310.6.0, Streamline 2.11.140');
  games.push(await makeFakeGame(services, {
    name: 'Iron Vanguard', exeName: 'IronVanguard.exe', root: path.join(gamesRoot, 'Iron Vanguard'),
    imports: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll'],
    dlssVersion: '310.7.0', streamlineVersion: '2.12.129',
  }));
  log('Iron Vanguard  — DirectX 11, DLSS 310.7.0, Streamline 2.12.129');
  games.push(await makeFakeGame(services, {
    name: 'Starfall Odyssey', exeName: 'StarfallOdyssey.exe', root: path.join(gamesRoot, 'Starfall Odyssey'),
    imports: ['kernel32.dll', 'd3d12.dll', 'dxgi.dll'],
    dlssVersion: '310.9.0', streamlineVersion: '2.12.129', withReShade: true,
  }));
  log('Starfall Odyssey — DirectX 12, DLSS 310.9.0, ReShade installed (conflict scenario)');

  head('Configuring scan folders and running the real detector');
  await services.settings.set({
    'scan.steam': true, 'scan.epic': true, 'scan.xbox': true, 'scan.gog': true, 'scan.customFolders': true,
    customGameFolders: [gamesRoot],
    scanDepth: 3,
  });
  const scanned = await gameStore.scan();
  for (const g of scanned) log(`detected: ${g.name}  [${g.provider}]  ${g.installDir}`);
  if (scanned.length < 3) throw new Error('folder detector found fewer games than expected');

  // --------------------------------------------------------------- runtimes
  head('Importing runtime packages (validated + hashed)');
  for (const version of ['310.6.0', '310.8.1', '310.9.1']) {
    const { filePaths } = await makeRuntimePackageFiles(services, version, {});
    const res = await runtimeLibrary.importPackage({ version, filePaths, origin: 'demo-seed' });
    if (!res || res.ok === false) throw new Error(`import ${version} failed: ${JSON.stringify(res && res.errors)}`);
    log(`imported ${version} (${(res.package && res.package.files || []).length} files, origin demo-seed)`);
  }

  // ------------------------------------------------------------- installs
  head('Running real installs (backup → validate → install → verify)');
  const byName = (n) => scanned.find((g) => g.name === n);
  const nebula = byName('Nebula Drift');
  const iron = byName('Iron Vanguard');
  const starfall = byName('Starfall Odyssey');

  const r1 = await runtimeInstaller.install({ gameId: nebula.id, version: '310.9.1' }, () => {});
  log(`Nebula Drift   → 310.9.1 : ${r1.ok ? 'success' : r1.code} ${r1.backupId ? `(backup ${r1.backupId})` : ''}`);
  const r2 = await runtimeInstaller.install({ gameId: iron.id, version: '310.8.1' }, () => {});
  log(`Iron Vanguard  → 310.8.1 : ${r2.ok ? 'success' : r2.code} ${r2.backupId ? `(backup ${r2.backupId})` : ''}`);
  if (!r1.ok || !r2.ok) {
    throw new Error(`expected successful demo installs: ${JSON.stringify(r1.error || r2.error)}`);
  }

  // ------------------------------------------------------------- injections
  head('Building + installing DLSS 5 Neural Rendering packages');
  const stage = path.join(dataDir, 'demo-injection-stage');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });

  // OptiScaler-style package: proxy + config
  const optiDir = path.join(stage, 'optiscaler');
  await fsp.mkdir(optiDir, { recursive: true });
  await fsp.writeFile(path.join(optiDir, 'nvngx.dll'), buildPeDll({
    fileVersion: '0.7.5.0', fileDescription: 'OptiScaler DLSS-NR proxy (synthetic demo)',
    productName: 'OptiScaler', originalFilename: 'nvngx.dll',
  }));
  await fsp.writeFile(path.join(optiDir, 'OptiScaler.ini'),
    '; OptiScaler demo configuration\n[General]\nUpscaler=dlss\n');
  const pkgA = await injectionLibrary.importPackage({
    name: 'DLSS 5 NR — OptiScaler variant',
    description: 'Demo injection package routed through an OptiScaler-style proxy.',
    filePaths: [path.join(optiDir, 'nvngx.dll'), path.join(optiDir, 'OptiScaler.ini')],
    origin: 'demo-seed',
  });
  if (!pkgA || pkgA.ok === false) throw new Error(`optiscaler package import failed: ${JSON.stringify(pkgA && pkgA.errors)}`);
  log(`package: ${pkgA.package ? pkgA.package.name : pkgA.name} [${(pkgA.package || pkgA).methods.join(', ')}]`);

  // ReShade-style package: 64-bit add-on
  const rsDir = path.join(stage, 'reshade');
  await fsp.mkdir(rsDir, { recursive: true });
  await fsp.writeFile(path.join(rsDir, 'dlss5nr.addon64'), buildPeDll({
    fileVersion: '5.0.1.0', fileDescription: 'DLSS 5 NR ReShade add-on (synthetic demo)',
    productName: 'DLSS5 NR', originalFilename: 'dlss5nr.addon64',
  }));
  const pkgB = await injectionLibrary.importPackage({
    name: 'DLSS 5 NR — ReShade add-on',
    description: 'Demo injection package installed as a ReShade add-on (append-only INI merge).',
    filePaths: [path.join(rsDir, 'dlss5nr.addon64')],
    origin: 'demo-seed',
  });
  if (!pkgB || pkgB.ok === false) throw new Error(`reshade package import failed: ${JSON.stringify(pkgB && pkgB.errors)}`);
  log(`package: ${pkgB.package ? pkgB.package.name : pkgB.name} [${(pkgB.package || pkgB).methods.join(', ')}]`);

  const iA = await injectionService.install({
    gameId: nebula.id, injectionId: (pkgA.package || pkgA).id, method: 'optiscaler',
  }, () => {});
  log(`Nebula Drift   + OptiScaler injection : ${iA.ok ? 'success' : iA.code}`);
  const iB = await injectionService.install({
    gameId: starfall.id, injectionId: (pkgB.package || pkgB).id, method: 'reshade',
  }, () => {});
  log(`Starfall Odyssey + ReShade add-on    : ${iB.ok ? 'success' : iB.code}`);
  if (!iA.ok || !iB.ok) {
    throw new Error(`injection installs failed: ${JSON.stringify(iA.error || iB.error)}`);
  }

  // ---------------------------------------------------------------- summary
  head('Demo environment ready');
  const entries = await history.list(50);
  const backupList = await backups.list();
  log(`games:      ${scanned.length}`);
  log(`runtimes:   ${(await runtimeLibrary.listAvailability()).filter((r) => r.available).length} imported packages`);
  log(`backups:    ${backupList.length}`);
  log(`history:    ${entries.length} entries (${entries.map((e) => `${e.action}:${e.result}`).join(', ')})`);
  const analysis = await analyzer.analyze(starfall);
  log(`Starfall conflicts: ReShade detected=${!!(analysis.reshade && analysis.reshade.installed)} (shown on its game page)`);
  console.log(`
Next steps:
  npm run webdev        → open http://localhost:8123  (browser preview, same core)
  npm start             → Electron desktop app (Windows/macOS/Linux with a display)
The demo data lives in: ${dataDir}  (delete it any time; it is gitignored)`);
}

main().catch((err) => {
  console.error('\nseed-demo failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
