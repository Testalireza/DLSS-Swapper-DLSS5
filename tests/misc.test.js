'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { makeTestEnv, fakeRunner } = require('./helpers');
const { GpuService } = require('../src/core/compatibility/gpuInfo');
const { areProcessesRunning } = require('../src/core/fileOperations/processCheck');
const { ensureCsvValueText, setIfMissingText, readValue } = require('../src/core/injection/ini');
const { stageFiles, commitStaged, removeInstalledFiles, isFileLocked } = require('../src/core/fileOperations/safeOps');
const { checkForUpdate } = require('../src/core/updates/updater');
const { hashFile } = require('../src/core/hash');

// --------------------------------------------------------------------- GPU

test('GPU: RTX 4070 Laptop via nvidia-smi → supported, Ada Lovelace', () => {
  const cls = GpuService.classify('NVIDIA GeForce RTX 4070 Laptop GPU', 8.9);
  assert.equal(cls.architecture, 'Ada Lovelace');
  assert.equal(cls.series, 'RTX 40 series');
  assert.equal(cls.isRtx, true);
  assert.equal(cls.dlssCapable, true);
  assert.equal(cls.confidence, 'high');

  const compat = GpuService.assessCompatibility(
    { name: 'NVIDIA GeForce RTX 4070 Laptop GPU', vendor: 'NVIDIA', driverVersion: '591.44', computeCapability: 8.9, ...cls },
    [{ name: 'x' }],
    { detectedVia: ['nvidia-smi'], override: false, minDriver: '580.00' }
  );
  assert.equal(compat.status, 'supported');
});

test('GPU: RTX 5090 → Blackwell; RTX 2060 → Turing supported; RTX 3080 → Ampere', () => {
  assert.equal(GpuService.classify('NVIDIA GeForce RTX 5090', 12.0).architecture, 'Blackwell');
  assert.equal(GpuService.classify('NVIDIA GeForce RTX 2060', 7.5).architecture, 'Turing');
  assert.equal(GpuService.classify('NVIDIA GeForce RTX 3080', 8.6).architecture, 'Ampere');
});

test('GPU: GTX 1070 (compute 6.1) → unsupported', () => {
  const cls = GpuService.classify('NVIDIA GeForce GTX 1070', 6.1);
  assert.equal(cls.dlssCapable, false);
  const compat = GpuService.assessCompatibility(
    { name: 'NVIDIA GeForce GTX 1070', vendor: 'NVIDIA', driverVersion: '550.1', computeCapability: 6.1, ...cls },
    [{ name: 'x' }],
    { detectedVia: ['nvidia-smi'], override: false, minDriver: '580.00' }
  );
  assert.equal(compat.status, 'unsupported');
  assert.ok(compat.reasons.join(' ').includes('Tensor Cores'));
});

test('GPU: no detection possible → unknown + can override', () => {
  const compat = GpuService.assessCompatibility(null, [], { detectedVia: [], override: true, minDriver: '580.00' });
  assert.equal(compat.status, 'unknown');
  assert.equal(compat.canOverride, true);
  assert.equal(compat.overridden, true);
  assert.match(compat.headline, /could not be fully verified/i);
});

test('GPU: name-only RTX detection → supported with low-confidence warning', () => {
  const cls = GpuService.classify('NVIDIA GeForce RTX 3060', null);
  assert.equal(cls.confidence, 'medium');
  const compat = GpuService.assessCompatibility(
    { name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', driverVersion: null, computeCapability: null, ...cls },
    [{ name: 'x' }],
    { detectedVia: ['wmi'], override: false, minDriver: '580.00' }
  );
  assert.equal(compat.status, 'supported');
  assert.ok(compat.warnings.some((w) => w.includes('name alone')));
});

test('GPU: service parses nvidia-smi CSV output', async (t) => {
  const runner = fakeRunner({
    'nvidia-smi': () => ({
      stdout: 'NVIDIA GeForce RTX 4070 Laptop GPU, 591.44, 8188, 8.9\n',
      stderr: '', code: 0,
    }),
  });
  const ctx = await makeTestEnv({ runner });
  t.after(ctx.cleanup);
  const info = await ctx.services.gpu.getInfo(true);
  assert.equal(info.gpus.length, 1);
  assert.equal(info.nvidia.name, 'NVIDIA GeForce RTX 4070 Laptop GPU');
  assert.equal(info.nvidia.driverVersion, '591.44');
  assert.equal(info.nvidia.vramBytes, 8188 * 1024 * 1024);
  assert.equal(info.compatibility.status, 'supported');
  assert.ok(info.detectedVia.includes('nvidia-smi'));
});

test('GPU: driver normalization WMI 32.0.15.8065 → 580.65', () => {
  assert.equal(GpuService.normalizeDriver('32.0.15.8065'), '580.65');
  assert.equal(GpuService.normalizeDriver('591.44'), '591.44');
});

// ------------------------------------------------------------- processCheck

test('ProcessCheck: linux pgrep hit and miss', async () => {
  const hit = fakeRunner({ pgrep: () => ({ stdout: '999\n', stderr: '', code: 0 }) });
  const miss = fakeRunner({ pgrep: () => ({ stdout: '', stderr: '', code: 1 }) });
  const { AppEnv } = require('../src/core/env');
  const envHit = new AppEnv({ dataDir: '/tmp/x1', platform: 'linux', runner: hit });
  const envMiss = new AppEnv({ dataDir: '/tmp/x2', platform: 'linux', runner: miss });
  assert.equal((await areProcessesRunning(envHit, ['game.exe'])).running, true);
  assert.equal((await areProcessesRunning(envMiss, ['game.exe'])).running, false);
});

test('ProcessCheck: windows tasklist CSV parsing', async () => {
  const runner = fakeRunner({
    tasklist: () => ({ stdout: '"eldenring.exe","4321","Console","1","1,234 K"\n', stderr: '', code: 0 }),
  });
  const { AppEnv } = require('../src/core/env');
  const env = new AppEnv({ dataDir: '/tmp/x3', platform: 'win32', runner });
  const res = await areProcessesRunning(env, ['eldenring.exe']);
  assert.equal(res.running, true);
  assert.equal(res.processes[0].pid, 4321);
});

// ---------------------------------------------------------------------- INI

test('INI: ensureCsvValue appends without clobbering, idempotent', () => {
  const base = '; my reshade config\r\n[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\r\n\r\n[ADDONS]\r\nAddonSearchPaths=.\\addons\r\n';
  let r = ensureCsvValueText(base, 'ADDONS', 'AddonSearchPaths', '.');
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('AddonSearchPaths=.\\addons,.'), r.text);
  assert.ok(r.text.includes('; my reshade config'), 'comment preserved');
  assert.ok(r.text.includes('\r\n'), 'CRLF preserved');
  r = ensureCsvValueText(r.text, 'ADDONS', 'AddonSearchPaths', '.');
  assert.equal(r.changed, false, 'idempotent');
  // missing section gets appended
  r = ensureCsvValueText('[GENERAL]\nX=1\n', 'ADDONS', 'AddonSearchPaths', '.');
  assert.equal(r.changed, true);
  assert.match(r.text, /\[ADDONS\]\nAddonSearchPaths=\./);
});

test('INI: setIfMissing never modifies an existing key', () => {
  const base = '[DLSS]\nNeuralRendering=false\n';
  const r = setIfMissingText(base, 'DLSS', 'NeuralRendering', 'true');
  assert.equal(r.changed, false);
  assert.equal(r.text, base);
  const r2 = setIfMissingText(base, 'DLSS', 'Other', 'x');
  assert.equal(r2.changed, true);
  assert.match(r2.text, /Other=x/);
});

test('INI: readValue', async (t) => {
  const dir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'ini-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'test.ini');
  await fsp.writeFile(f, '[S]\nKey=Value\n');
  assert.equal(await readValue(f, 'S', 'Key'), 'Value');
  assert.equal(await readValue(f, 'S', 'Missing'), null);
  assert.equal(await readValue(path.join(dir, 'nope.ini'), 'S', 'Key'), null);
});

// ------------------------------------------------------------------ safeOps

test('safeOps: stage validates hashes, commit verifies targets, rollback is safe', async (t) => {
  const dir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'safeops-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src.dll');
  await fsp.writeFile(src, 'source-content');
  const sha = await hashFile(src);
  const target = path.join(dir, 'game');
  await fsp.mkdir(target);

  // bad hash → staging refuses
  let staged = await stageFiles({ targetDir: target, operations: [{ sourcePath: src, fileName: 'src.dll', sha256: 'deadbeef' }] });
  assert.equal(staged.ok, false);
  assert.ok(!fs.existsSync(path.join(target, 'src.dll')));

  // good hash → stage + commit + verify
  staged = await stageFiles({ targetDir: target, operations: [{ sourcePath: src, fileName: 'src.dll', sha256: sha }] });
  assert.equal(staged.ok, true);
  const commit = await commitStaged({ staged: staged.staged, targetDir: target });
  assert.equal(commit.ok, true);
  assert.equal(await hashFile(path.join(target, 'src.dll')), sha);

  // rollback removes it (hash matches)
  const rm = await removeInstalledFiles({ committed: commit.committed, targetDir: target });
  assert.deepEqual(rm.removed, ['src.dll']);
  assert.equal(fs.existsSync(path.join(target, 'src.dll')), false);
});

test('safeOps: removeInstalledFiles keeps files the user changed afterwards', async (t) => {
  const dir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'safeops2-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'installed.dll');
  await fsp.writeFile(f, 'installed-by-us-then-changed');
  const rm = await removeInstalledFiles({
    committed: [{ fileName: 'installed.dll', targetPath: f, sha256: 'a'.repeat(64) }],
    targetDir: dir,
  });
  assert.equal(rm.removed.length, 0);
  assert.equal(rm.kept.length, 1);
  assert.ok(fs.existsSync(f));
});

test('safeOps: isFileLocked reports false for normal files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'lock-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'x.bin');
  await fsp.writeFile(f, 'x');
  assert.equal(await isFileLocked(f), false);
});

// ------------------------------------------------------------------ history

test('History: add, list (newest first), filter by game, update', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const a = await ctx.services.history.add({ gameId: 'g1', gameName: 'One', action: 'runtime-install', toVersion: '310.9.1', result: 'success' });
  const b = await ctx.services.history.add({ gameId: 'g2', gameName: 'Two', action: 'injection-install', method: 'reshade', result: 'success' });
  const all = await ctx.services.history.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, b.id, 'newest first');
  const g1 = await ctx.services.history.list(10, 'g1');
  assert.equal(g1.length, 1);
  const upd = await ctx.services.history.update(a.id, { result: 'rolled-back' });
  assert.equal(upd.result, 'rolled-back');
});

// ------------------------------------------------------------------ updater

test('Updater: newer release → update available', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const origFetch = global.fetch;
  t.after(() => { global.fetch = origFetch; });
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ tag_name: 'v9.9.9', name: 'Future', html_url: 'https://example.test/rel', published_at: '2026-09-01T00:00:00Z', body: 'notes' }),
  });
  const res = await checkForUpdate({ env: ctx.env, settings: ctx.services.settings, logger: ctx.services.logger });
  assert.equal(res.ok, true);
  assert.equal(res.updateAvailable, true);
  assert.equal(res.latest.version, '9.9.9');
});

test('Updater: no releases (404) and network failure are handled gracefully', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const origFetch = global.fetch;
  t.after(() => { global.fetch = origFetch; });
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  let res = await checkForUpdate({ env: ctx.env, settings: ctx.services.settings, logger: ctx.services.logger });
  assert.equal(res.ok, true);
  assert.equal(res.updateAvailable, false);

  global.fetch = async () => { throw new Error('offline'); };
  res = await checkForUpdate({ env: ctx.env, settings: ctx.services.settings, logger: ctx.services.logger });
  assert.equal(res.ok, false);
  assert.match(res.error, /offline/);
});

// ------------------------------------------------------------------- logger

test('Logger: writes structured lines and honours logging disabled', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  await ctx.services.logger.info('hello world', { gameId: 'g1' });
  await ctx.services.logger.success('done');
  const file = ctx.services.logger.logFile();
  const text = await fsp.readFile(file, 'utf8');
  assert.match(text, /\[INFO\] hello world \{"gameId":"g1"\}/);
  assert.match(text, /\[SUCCESS\] done/);

  await ctx.services.settings.set({ loggingEnabled: false });
  await ctx.services.logger.info('after disable');
  const text2 = await fsp.readFile(file, 'utf8');
  assert.ok(!text2.includes('after disable'));
  // ring buffer still receives it for the UI
  assert.ok(ctx.services.logger.recent().some((e) => e.message === 'after disable'));
});

test('Logger: DEBUG suppressed unless verbose/advanced', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  await ctx.services.logger.debug('hidden detail');
  assert.ok(!ctx.services.logger.recent().some((e) => e.message === 'hidden detail'));
  await ctx.services.settings.set({ advancedMode: true });
  await ctx.services.logger.debug('visible detail');
  assert.ok(ctx.services.logger.recent().some((e) => e.message === 'visible detail'));
});
