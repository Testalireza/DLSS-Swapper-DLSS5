'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const path = require('path');
const { makeTestEnv, makeFakeGame, registerGame, importRuntime } = require('./helpers');
const { buildPeDll } = require('../src/core/pe/peBuilder');

test('Analyzer: full DX12 game — exe, API, DLSS + Streamline versions', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Aurora Protocol', dlssVersion: '310.7.129', streamlineVersion: '2.12.129' });
  const game = await registerGame(ctx.services, g);

  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.ok, true, a.errors.join(';'));
  assert.equal(a.executable.name, 'aurora.exe');
  assert.deepEqual(a.graphicsApi.map((x) => x.api), ['DirectX 12']);
  assert.equal(a.is64bit, true);

  assert.equal(a.dlss.detected, true);
  assert.equal(a.dlss.primaryVersion, '310.7.129.0');
  assert.equal(a.dlss.versionSource, 'PE version resource');
  assert.equal(a.streamline.detected, true);
  assert.equal(a.streamline.version, '2.12.129.0');
  assert.equal(a.injection.installed, false);
});

test('Analyzer: picks the real game exe over uninstallers/reporters', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Neon Drift 2', exeName: 'neondrift2.exe', withDecoys: true });
  const game = await registerGame(ctx.services, { ...g, exePath: null, exeName: null });
  // Remove store-provided exe hint so scoring must decide:
  game.exeName = null;
  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.executable.name, 'neondrift2.exe');
});

test('Analyzer: unknown DLSS version when PE lacks resources → hash match works', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  // Import a package whose core DLL has NO readable PE version resource
  // (simulating a stripped/obfuscated build). Identity must then come from
  // the runtime library hash index.
  const junkDir = path.join(ctx.dir, 'junk-pkg');
  await fsp.mkdir(junkDir, { recursive: true });
  const junkDll = path.join(junkDir, 'nvngx_dlss.dll');
  await fsp.writeFile(junkDll, Buffer.concat([Buffer.from('RAW-BINARY-WITHOUT-PE-HEADER'), require('crypto').randomBytes(512)]));
  const imp = await ctx.services.runtimeLibrary.importPackage({ version: '310.6.1', filePaths: [junkDll] });
  assert.equal(imp.ok, true, imp.errors.join(';'));
  assert.ok(imp.warnings.some((w) => w.includes('no readable PE version resource')));

  const g = await makeFakeGame(ctx.services, { name: 'Hash Game', dlssVersion: null, withStreamline: false });
  await fsp.copyFile(junkDll, path.join(g.installDir, 'nvngx_dlss.dll'));
  const game = await registerGame(ctx.services, g);

  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.dlss.detected, true);
  assert.equal(a.dlss.versionSource, 'runtime library hash match');
  assert.equal(a.dlss.primaryVersion, '310.6.1');
  assert.equal(a.dlss.files[0].knownRuntimeVersion, '310.6.1');
});

test('Analyzer: Vulkan imports are detected', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, {
    name: 'Vulkan Game', imports: ['kernel32.dll', 'vulkan-1.dll'], dlssVersion: null, withStreamline: false,
  });
  const game = await registerGame(ctx.services, g);
  const a = await ctx.services.analyzer.analyze(game);
  assert.deepEqual(a.graphicsApi.map((x) => x.api), ['Vulkan']);
});

test('Analyzer: missing install dir reports an error, not a crash', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const game = { id: 'manual-ghost', name: 'Ghost', provider: 'manual', installDir: path.join(ctx.dir, 'nope') };
  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.ok, false);
  assert.ok(a.errors[0].includes('does not exist'));
});

test('Analyzer: detects ReShade and OptiScaler footprints + injection via marker', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Reshaded', withReShade: true });
  const game = await registerGame(ctx.services, g);
  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.reshade.installed, true);
  assert.ok(a.reshade.evidence.length >= 2);
  assert.equal(path.basename(a.reshade.proxyDll), 'dxgi.dll');

  const g2 = await makeFakeGame(ctx.services, { name: 'OptiGame', withOptiScaler: true, withReShade: false });
  const game2 = await registerGame(ctx.services, g2);
  const a2 = await ctx.services.analyzer.analyze(game2);
  assert.equal(a2.optiscaler.detected, true);
  assert.ok(a2.optiscaler.evidence.some((e) => e.includes('OptiScaler.ini')));

  // Marker-based injection recognition
  const marker = {
    schemaVersion: 1, app: 'DLSS Swapper 5', appVersion: '1.0.0',
    operations: [{ type: 'injection-install', injectionId: 'inj-x', injectionName: 'DLSS5 NR Patch', method: 'reshade', at: new Date().toISOString(), files: [] }],
  };
  await fsp.writeFile(path.join(g.installDir, '.dlss5swapper-marker.json'), JSON.stringify(marker));
  const a3 = await ctx.services.analyzer.analyze(game);
  assert.equal(a3.injection.installed, true);
  assert.equal(a3.injection.method, 'reshade');
  assert.equal(a3.injection.injectionName, 'DLSS5 NR Patch');
});

test('Analyzer: 32-bit games are flagged', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Old Game', arch: 'x86', dlssVersion: '310.6.0', streamlineVersion: null, withStreamline: false });
  const game = await registerGame(ctx.services, g);
  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.is64bit, false);
});

test('Analyzer: exe in a Binaries subfolder is found (Unreal-style layout)', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const root = path.join(ctx.dir, 'UnrealGame');
  const bin = path.join(root, 'Binaries', 'Win64');
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(path.join(root, 'EasyAntiCheat.exe'), buildPeDll({ fileVersion: '1.0.0.0', originalFilename: 'EasyAntiCheat.exe' }));
  await fsp.writeFile(path.join(bin, 'UnrealGame.exe'), buildPeDll({
    fileVersion: '1.0.0.0', originalFilename: 'UnrealGame.exe', imports: ['d3d11.dll', 'dxgi.dll'],
  }));
  await fsp.writeFile(path.join(bin, 'nvngx_dlss.dll'), buildPeDll({ fileVersion: '310.8.0.0', originalFilename: 'nvngx_dlss.dll' }));
  const game = await registerGame(ctx.services, { name: 'Unreal Game', installDir: root, exePath: null });
  const a = await ctx.services.analyzer.analyze(game);
  assert.equal(a.executable.name, 'UnrealGame.exe');
  assert.equal(a.targetDir, bin);
  assert.equal(a.dlss.primaryVersion, '310.8.0.0');
  assert.deepEqual(a.graphicsApi.map((x) => x.api), ['DirectX 11']);
});
