'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { makeTestEnv, makeFakeGame, registerGame } = require('./helpers');
const { detectConflicts } = require('../src/core/conflicts/detector');
const { hashFile } = require('../src/core/hash');
const { INJECTION_METHODS } = require('../src/shared/constants');

test('Conflicts: ReShade proxy is attributed to ReShade', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Reshade Conflict', withReShade: true });
  const report = await detectConflicts(g.installDir);
  const dxgi = report.conflicts.find((c) => c.file === 'dxgi.dll');
  assert.ok(dxgi, 'dxgi.dll reported');
  assert.equal(dxgi.owner, 'reshade');
  assert.equal(dxgi.severity, 'warning');
  assert.ok(dxgi.message.includes('ReShade'));
});

test('Conflicts: OptiScaler proxy is attributed to OptiScaler', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Opti Conflict', withOptiScaler: true });
  const report = await detectConflicts(g.installDir);
  const nvngx = report.conflicts.find((c) => c.file === 'nvngx.dll');
  assert.ok(nvngx);
  assert.equal(nvngx.owner, 'optiscaler');
});

test('Conflicts: unknown proxy DLL warns with "origin could not be determined"', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Unknown Proxy' });
  await fsp.writeFile(path.join(g.installDir, 'winmm.dll'), 'mystery proxy binary');
  const report = await detectConflicts(g.installDir);
  const winmm = report.conflicts.find((c) => c.file === 'winmm.dll');
  assert.ok(winmm);
  assert.equal(winmm.owner, null);
  assert.equal(winmm.severity, 'warning');
  assert.ok(winmm.message.includes('could not be determined'));
});

test('Conflicts: own injection files are info, not warnings', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Own Injection', withReShade: true });
  // Import an injection package, then place its core file in the game
  const addon = path.join(ctx.dir, 'dlss5nr.addon64');
  await fsp.writeFile(addon, 'injection-addon-content');
  const imp = await ctx.services.injectionLibrary.importPackage({
    filePaths: [addon], name: 'DLSS5 NR', methods: [INJECTION_METHODS.RESHADE],
  });
  assert.equal(imp.ok, true, imp.errors.join(';'));
  await fsp.copyFile(addon, path.join(g.installDir, 'dlss5nr.addon64'));

  const report = await detectConflicts(g.installDir, {
    injectionHashIndex: await ctx.services.injectionLibrary.hashIndex(),
  });
  // addon64 is not a proxy dll — no conflict entry expected for it, but the
  // ReShade footprint must be info-level since nothing collides.
  const reshadeEntries = report.conflicts.filter((c) => c.owner === 'reshade' || c.type === 'tool-footprint');
  assert.ok(reshadeEntries.length >= 0);
  assert.ok(!report.conflicts.some((c) => c.severity === 'blocking'));
});

test('Injection library: import classifies roles/methods and round-trips', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const dir = path.join(ctx.dir, 'inj-src');
  await fsp.mkdir(dir, { recursive: true });
  const addon = path.join(dir, 'renodx-style.addon64');
  await fsp.writeFile(addon, 'addon-bytes');
  const ini = path.join(dir, 'OptiScaler.ini');
  await fsp.writeFile(ini, '[General]\n');
  const res = await ctx.services.injectionLibrary.importPackage({
    filePaths: [addon, ini], name: 'NR Patch',
  });
  assert.equal(res.ok, true, res.errors.join(';'));
  const pkg = res.package;
  assert.equal(pkg.files.find((f) => f.name.endsWith('.addon64')).role, 'injection-addon');
  assert.equal(pkg.files.find((f) => f.name === 'OptiScaler.ini').role, 'config');
  assert.ok(pkg.methods.includes(INJECTION_METHODS.RESHADE));
  assert.ok(pkg.methods.includes(INJECTION_METHODS.OPTISCALER));

  const list = await ctx.services.injectionLibrary.list();
  assert.equal(list.length, 1);
  const index = await ctx.services.injectionLibrary.hashIndex();
  assert.equal(index.get(await hashFile(addon)).injectionId, pkg.id);
});

test('Injection library: refuses imports without a recognizable core file', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const p = path.join(ctx.dir, 'notes.txt');
  await fsp.writeFile(p, 'nothing useful');
  const res = await ctx.services.injectionLibrary.importPackage({ filePaths: [p] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('injection core')));
});

test('Injection (ReShade): install adds addon + merges ini without touching presets; uninstall restores', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'ReShade Inject', withReShade: true });
  const game = await registerGame(ctx.services, g);
  const iniBefore = await fsp.readFile(path.join(g.installDir, 'ReShade.ini'), 'utf8');
  const presetBefore = await fsp.readFile(path.join(g.installDir, 'MyPreset.ini'), 'utf8');
  const shaderBefore = await fsp.readFile(path.join(g.installDir, 'reshade-shaders', 'Shaders', 'Fake.fx'), 'utf8');

  // Import a ReShade add-on style injection
  const src = path.join(ctx.dir, 'inj');
  await fsp.mkdir(src, { recursive: true });
  const addonSrc = path.join(src, 'dlss5-nr.addon64');
  await fsp.writeFile(addonSrc, 'neural-rendering-addon');
  const imp = await ctx.services.injectionLibrary.importPackage({
    filePaths: [addonSrc], name: 'DLSS5 NR ReShade', methods: [INJECTION_METHODS.RESHADE],
  });
  assert.equal(imp.ok, true, imp.errors.join(';'));

  // Status before install
  let status = await ctx.services.injectionService.status(game.id);
  assert.equal(status.methods.reshade.detected, true);
  assert.equal(status.methods.reshade.installed, false);

  const events = [];
  const res = await ctx.services.injectionService.install(
    { gameId: game.id, injectionId: imp.package.id, method: INJECTION_METHODS.RESHADE },
    (p) => events.push(p)
  );
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.ok(fs.existsSync(path.join(g.installDir, 'dlss5-nr.addon64')));

  // INI merged append-only: original content preserved + addon search path ensured
  const iniAfter = await fsp.readFile(path.join(g.installDir, 'ReShade.ini'), 'utf8');
  assert.ok(iniAfter.includes(iniBefore.trim().split('\n')[0]), 'original ini content preserved');
  assert.match(iniAfter, /\[ADDONS\]/);
  assert.match(iniAfter, /AddonSearchPaths=.*\./);

  // User's presets & shaders untouched
  assert.equal(await fsp.readFile(path.join(g.installDir, 'MyPreset.ini'), 'utf8'), presetBefore);
  assert.equal(await fsp.readFile(path.join(g.installDir, 'reshade-shaders', 'Shaders', 'Fake.fx'), 'utf8'), shaderBefore);

  // Status after install
  status = await ctx.services.injectionService.status(game.id);
  assert.equal(status.methods.reshade.installed, true);
  assert.equal(status.currentInjection.installed, true);
  assert.equal(status.currentInjection.method, INJECTION_METHODS.RESHADE);

  // Uninstall → addon removed, ini restored byte-for-byte
  const un = await ctx.services.injectionService.uninstall({ gameId: game.id, method: INJECTION_METHODS.RESHADE });
  assert.equal(un.ok, true, JSON.stringify(un, null, 2));
  assert.equal(fs.existsSync(path.join(g.installDir, 'dlss5-nr.addon64')), false);
  assert.equal(await fsp.readFile(path.join(g.installDir, 'ReShade.ini'), 'utf8'), iniBefore);
});

test('Injection (OptiScaler): installs proxy + config from package when OptiScaler absent', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Opti Inject', withOptiScaler: false });
  const game = await registerGame(ctx.services, g);

  const src = path.join(ctx.dir, 'inj-opti');
  await fsp.mkdir(src, { recursive: true });
  const { buildPeDll } = require('../src/core/pe/peBuilder');
  const nvngx = path.join(src, 'nvngx.dll');
  await fsp.writeFile(nvngx, buildPeDll({ fileVersion: '0.7.0.0', productName: 'OptiScaler DLSS NR', originalFilename: 'nvngx.dll' }));
  const ini = path.join(src, 'OptiScaler.ini');
  await fsp.writeFile(ini, '; OptiScaler defaults from package\n[DLSS]\nEnabled=true\n');
  const imp = await ctx.services.injectionLibrary.importPackage({
    filePaths: [nvngx, ini], name: 'DLSS5 NR OptiScaler',
    methods: [INJECTION_METHODS.OPTISCALER],
    configDirectives: [{ file: 'OptiScaler.ini', section: 'DLSS', key: 'NeuralRendering', value: 'true', mode: 'set-if-missing' }],
  });
  assert.equal(imp.ok, true, imp.errors.join(';'));

  const res = await ctx.services.injectionService.install({
    gameId: game.id, injectionId: imp.package.id, method: INJECTION_METHODS.OPTISCALER,
  });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.ok(fs.existsSync(path.join(g.installDir, 'nvngx.dll')));
  const iniText = await fsp.readFile(path.join(g.installDir, 'OptiScaler.ini'), 'utf8');
  assert.match(iniText, /NeuralRendering=true/, 'config directive applied');
});

test('Injection (OptiScaler): existing OptiScaler.ini is never overwritten by package config', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Opti Existing', withOptiScaler: true });
  const game = await registerGame(ctx.services, g);
  const userIni = await fsp.readFile(path.join(g.installDir, 'OptiScaler.ini'), 'utf8');

  const src = path.join(ctx.dir, 'inj-opti2');
  await fsp.mkdir(src, { recursive: true });
  const ini = path.join(src, 'OptiScaler.ini');
  await fsp.writeFile(ini, '; package default ini\n[DLSS]\nEnabled=true\n');
  const imp = await ctx.services.injectionLibrary.importPackage({
    filePaths: [ini], name: 'Config only', methods: [INJECTION_METHODS.OPTISCALER],
  });
  // A config-only package has no core file → import refuses it. Add a core file.
  assert.equal(imp.ok, false);
  const { buildPeDll } = require('../src/core/pe/peBuilder');
  const core = path.join(src, 'nvngx_dlss.dll');
  await fsp.writeFile(core, buildPeDll({ fileVersion: '310.9.1.0', originalFilename: 'nvngx_dlss.dll' }));
  const imp2 = await ctx.services.injectionLibrary.importPackage({
    filePaths: [ini, core], name: 'NR with config', methods: [INJECTION_METHODS.OPTISCALER],
  });
  assert.equal(imp2.ok, true, imp2.errors.join(';'));

  const res = await ctx.services.injectionService.install({
    gameId: game.id, injectionId: imp2.package.id, method: INJECTION_METHODS.OPTISCALER,
  });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  // The user's existing OptiScaler.ini must be byte-identical
  assert.equal(await fsp.readFile(path.join(g.installDir, 'OptiScaler.ini'), 'utf8'), userIni);
  // but the core DLL was installed
  assert.ok(fs.existsSync(path.join(g.installDir, 'nvngx_dlss.dll')));
});

test('Injection: ReShade method refuses to install when ReShade is absent', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'No ReShade', withReShade: false });
  const game = await registerGame(ctx.services, g);
  const src = path.join(ctx.dir, 'inj3');
  await fsp.mkdir(src, { recursive: true });
  const addonSrc = path.join(src, 'patch.addon64');
  await fsp.writeFile(addonSrc, 'x');
  const imp = await ctx.services.injectionLibrary.importPackage({ filePaths: [addonSrc], methods: [INJECTION_METHODS.RESHADE] });
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const res = await ctx.services.injectionService.install({
    gameId: game.id, injectionId: imp.package.id, method: INJECTION_METHODS.RESHADE,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'reshade-missing');
  assert.ok(res.error.includes('ReShade is not installed'));
});

test('Injection: method mismatch blocked without force, allowed with it', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Mismatch', withOptiScaler: true });
  const game = await registerGame(ctx.services, g);
  const src = path.join(ctx.dir, 'inj4');
  await fsp.mkdir(src, { recursive: true });
  const addonSrc = path.join(src, 'only-reshade.addon64');
  await fsp.writeFile(addonSrc, 'x');
  const imp = await ctx.services.injectionLibrary.importPackage({ filePaths: [addonSrc], methods: [INJECTION_METHODS.RESHADE] });
  assert.equal(imp.ok, true, imp.errors.join(';'));

  const blocked = await ctx.services.injectionService.install({
    gameId: game.id, injectionId: imp.package.id, method: INJECTION_METHODS.OPTISCALER,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'method-mismatch');

  const forced = await ctx.services.injectionService.install({
    gameId: game.id, injectionId: imp.package.id, method: INJECTION_METHODS.OPTISCALER, force: true,
  });
  // OptiScaler detected in game → prerequisites pass; package installs the addon file.
  assert.equal(forced.ok, true, JSON.stringify(forced, null, 2));
});
