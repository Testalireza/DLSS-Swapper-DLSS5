'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const path = require('path');
const { makeTestEnv, makeRuntimePackageFiles } = require('./helpers');
const { compareVersions } = require('../src/shared/format');
const { SettingsService } = require('../src/core/settings');

test('Manifests: database covers 310.6.0 → 310.9.1, sorted', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const runtimes = await ctx.services.manifests.list();
  assert.ok(runtimes.length >= 9, 'expected the full version range');
  assert.equal(runtimes[0].version, '310.6.0');
  assert.equal(runtimes[runtimes.length - 1].version, '310.9.1');
  for (let i = 1; i < runtimes.length; i++) {
    assert.ok(compareVersions(runtimes[i - 1].version, runtimes[i].version) < 0, 'sorted ascending');
  }
  // Every entry has a required core file.
  for (const rt of runtimes) {
    assert.ok(rt.files.some((f) => f.required && f.name === 'nvngx_dlss.dll'), `${rt.version} missing core file`);
  }
  assert.deepEqual(ctx.services.manifests.loadErrors(), []);
});

test('Manifests: broken entry is reported but does not break the DB', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  // Build a writable resources dir: the shipped manifest + one malformed file.
  const { AppEnv } = require('../src/core/env');
  const { createServices } = require('../src/core/app-services');
  const res2 = path.join(ctx.dir, 'res2');
  await fsp.mkdir(path.join(res2, 'RuntimeManifests'), { recursive: true });
  await fsp.copyFile(
    path.join(ctx.env.resourcesDir, 'RuntimeManifests', 'runtimes.json'),
    path.join(res2, 'RuntimeManifests', 'runtimes.json')
  );
  await fsp.writeFile(
    path.join(res2, 'RuntimeManifests', 'bad.json'),
    JSON.stringify({ schemaVersion: 1, runtimes: [{ version: 'not-a-version', files: [] }] })
  );
  const env2 = new AppEnv({ dataDir: path.join(ctx.dir, 'data2'), resourcesDir: res2, platform: 'linux' });
  await env2.ensureDirs();
  const services2 = createServices({ env: env2 });
  const runtimes = await services2.manifests.list();
  assert.equal(runtimes[runtimes.length - 1].version, '310.9.1');
  assert.ok(services2.manifests.loadErrors().some((e) => e.file === 'bad.json'));
});

test('RuntimeLibrary: import → validate → hash index → delete lifecycle', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const { filePaths } = await makeRuntimePackageFiles(ctx.services, '310.9.1');
  const res = await ctx.services.runtimeLibrary.importPackage({ version: '310.9.1', filePaths });
  assert.equal(res.ok, true, res.errors.join(';'));
  assert.equal(res.package.complete, true);
  assert.ok(res.package.files.every((f) => f.sha256 && f.sizeBytes > 0));
  const core = res.package.files.find((f) => f.name === 'nvngx_dlss.dll');
  assert.equal(core.detectedVersion, '310.9.1.0');

  const check = await ctx.services.runtimeLibrary.validatePackage('310.9.1');
  assert.equal(check.ok, true);

  const index = await ctx.services.runtimeLibrary.hashIndex();
  assert.equal(index.get(core.sha256).version, '310.9.1');

  const del = await ctx.services.runtimeLibrary.deletePackage('310.9.1');
  assert.equal(del.ok, true);
  const after = await ctx.services.runtimeLibrary.validatePackage('310.9.1');
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'missing-package');
});

test('RuntimeLibrary: import rejects missing required file', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const { filePaths } = await makeRuntimePackageFiles(ctx.services, '310.6.0');
  const onlyOptional = filePaths.filter((p) => !p.endsWith('nvngx_dlss.dll'));
  const res = await ctx.services.runtimeLibrary.importPackage({ version: '310.6.0', filePaths: onlyOptional });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('nvngx_dlss.dll')));
});

test('RuntimeLibrary: import rejects version mismatch without override, accepts with it', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  // Build files claiming to be 310.6.0 but import as 310.9.1
  const { filePaths } = await makeRuntimePackageFiles(ctx.services, '310.6.0');
  const res = await ctx.services.runtimeLibrary.importPackage({ version: '310.9.1', filePaths });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('reports version')));

  const res2 = await ctx.services.runtimeLibrary.importPackage({ version: '310.9.1', filePaths, allowVersionMismatch: true });
  assert.equal(res2.ok, true);
  assert.ok(res2.warnings.some((w) => w.includes('override')));
});

test('RuntimeLibrary: corrupted package fails validation', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const { filePaths } = await makeRuntimePackageFiles(ctx.services, '310.8.0');
  const res = await ctx.services.runtimeLibrary.importPackage({ version: '310.8.0', filePaths });
  assert.equal(res.ok, true, res.errors.join(';'));
  // Corrupt a stored file after import
  const stored = ctx.services.runtimeLibrary.packageFilePath('310.8.0', 'nvngx_dlss.dll');
  const buf = await fsp.readFile(stored);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  await fsp.writeFile(stored, buf);
  const check = await ctx.services.runtimeLibrary.validatePackage('310.8.0');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'invalid-package');
  assert.ok(check.detail.includes('Hash mismatch'));
});

test('RuntimeLibrary: foreign files are skipped with a warning', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const { filePaths, dir } = await makeRuntimePackageFiles(ctx.services, '310.7.129');
  const foreign = path.join(dir, 'readme.txt');
  await fsp.writeFile(foreign, 'not part of the runtime');
  const res = await ctx.services.runtimeLibrary.importPackage({ version: '310.7.129', filePaths: [...filePaths, foreign] });
  assert.equal(res.ok, true, res.errors.join(';'));
  assert.ok(res.warnings.some((w) => w.includes('readme.txt')));
  assert.ok(!res.package.files.some((f) => f.name === 'readme.txt'));
});

test('Settings: defaults, dot-path patches, reset archives previous file', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const s = ctx.services.settings;
  const initial = await s.get();
  assert.equal(initial.theme, 'light');
  assert.equal(initial.autoBackup, true);

  await s.set({ 'scan.steam': false, advancedMode: true, customGameFolders: ['/x'] });
  const updated = await s.get();
  assert.equal(updated.scan.steam, false);
  assert.equal(updated.scan.epic, true, 'untouched keys preserved');
  assert.equal(updated.advancedMode, true);
  assert.deepEqual(updated.customGameFolders, ['/x']);

  // Reload from disk merges new defaults
  const s2 = new SettingsService(ctx.env);
  const reloaded = await s2.get();
  assert.equal(reloaded.scan.steam, false);

  const reset = await s.reset();
  assert.equal(reset.scan.steam, true);
  const dirEntries = await fsp.readdir(ctx.env.dataDir);
  assert.ok(dirEntries.some((f) => f.startsWith('settings.backup-')), 'old settings archived');
});
