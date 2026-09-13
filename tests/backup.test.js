'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { makeTestEnv, makeFakeGame, registerGame } = require('./helpers');
const { hashFile } = require('../src/core/hash');

test('Backup: create preserves originals with hashes + metadata', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Backup Game' });
  const game = await registerGame(ctx.services, g);

  const originalHash = await hashFile(path.join(g.installDir, 'nvngx_dlss.dll'));
  const res = await ctx.services.backups.create({
    game, targetDir: g.installDir,
    files: [{ relPath: 'nvngx_dlss.dll' }, { relPath: 'sl.common.dll' }],
    willAdd: ['nvngx_dlssd.dll'],
    operation: { type: 'runtime-install', version: '310.9.1' },
    runtimeBefore: { dlss: '310.7.129', streamline: '2.12.129' },
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.backupId);

  const meta = await ctx.services.backups.getMetadata(game.id, res.backupId);
  assert.equal(meta.game.name, 'Backup Game');
  assert.equal(meta.modifiedFiles.length, 2);
  assert.equal(meta.modifiedFiles[0].originalHash, originalHash);
  assert.equal(meta.operation.version, '310.9.1');
  assert.equal(meta.runtimeBefore.dlss, '310.7.129');
  assert.equal(meta.result, 'pending');

  // The backup copy exists and hashes to the same value.
  const backupCopy = path.join(meta.__dir, meta.modifiedFiles[0].backupRelPath);
  assert.equal(await hashFile(backupCopy), originalHash);

  const v = await ctx.services.backups.validate(game.id, res.backupId);
  assert.equal(v.ok, true, v.problems.join(';'));
});

test('Backup: never overwrites an existing backup — ids stay unique', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Twice Game' });
  const game = await registerGame(ctx.services, g);
  const a = await ctx.services.backups.create({ game, targetDir: g.installDir, files: [{ relPath: 'nvngx_dlss.dll' }], operation: { type: 'test' } });
  const b = await ctx.services.backups.create({ game, targetDir: g.installDir, files: [{ relPath: 'nvngx_dlss.dll' }], operation: { type: 'test' } });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.backupId, b.backupId);
  // Both dirs intact
  assert.ok(fs.existsSync(a.dir) && fs.existsSync(b.dir));
  const list = await ctx.services.backups.list(game.id);
  assert.equal(list.length, 2);
});

test('Backup: failed copy (source vanished mid-backup) leaves no half backup', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Vanish Game' });
  const game = await registerGame(ctx.services, g);
  const res = await ctx.services.backups.create({
    game, targetDir: g.installDir,
    files: [{ relPath: 'nvngx_dlss.dll' }, { relPath: 'does-not-exist.dll' }],
    operation: { type: 'test' },
  });
  assert.equal(res.ok, false);
  const list = await ctx.services.backups.list(game.id);
  assert.equal(list.length, 0, 'no partial backup left behind');
});

test('Restore: restores originals, verifies hashes, reports', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Restore Game' });
  const game = await registerGame(ctx.services, g);
  const target = path.join(g.installDir, 'nvngx_dlss.dll');
  const originalHash = await hashFile(target);

  const created = await ctx.services.backups.create({
    game, targetDir: g.installDir, files: [{ relPath: 'nvngx_dlss.dll' }], operation: { type: 'test' },
  });
  // Simulate an install replacing the file
  await fsp.writeFile(target, Buffer.from('REPLACED-CONTENT'.repeat(100)));
  assert.notEqual(await hashFile(target), originalHash);

  // dry run first
  const dry = await ctx.services.backups.restore(game.id, created.backupId, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.notEqual(await hashFile(target), originalHash, 'dry run must not modify');

  const res = await ctx.services.backups.restore(game.id, created.backupId);
  assert.equal(res.ok, true, res.errors.join(';'));
  assert.equal(await hashFile(target), originalHash);
  assert.equal(res.restored.length, 1);
});

test('Restore: removes files the operation added, keeps user-modified ones', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Added Game' });
  const game = await registerGame(ctx.services, g);
  const created = await ctx.services.backups.create({
    game, targetDir: g.installDir, files: [], willAdd: ['new1.dll', 'new2.dll'], operation: { type: 'test' },
  });
  // Simulate the install adding two files
  await fsp.writeFile(path.join(g.installDir, 'new1.dll'), 'added-by-us');
  await fsp.writeFile(path.join(g.installDir, 'new2.dll'), 'added-by-us');
  const h1 = await hashFile(path.join(g.installDir, 'new1.dll'));
  const h2 = await hashFile(path.join(g.installDir, 'new2.dll'));
  await ctx.services.backups.finalize(game.id, created.backupId, {
    addedFiles: [{ relPath: 'new1.dll', installedHash: h1 }, { relPath: 'new2.dll', installedHash: h2 }],
    result: 'success',
  });
  // User modifies new2 after install
  await fsp.appendFile(path.join(g.installDir, 'new2.dll'), '+user changes');

  const res = await ctx.services.backups.restore(game.id, created.backupId);
  assert.equal(res.ok, true, res.errors.join(';'));
  assert.equal(fs.existsSync(path.join(g.installDir, 'new1.dll')), false, 'our file removed');
  assert.equal(fs.existsSync(path.join(g.installDir, 'new2.dll')), true, 'user-modified file kept');
  assert.ok(res.warnings.some((w) => w.includes('new2.dll')));
});

test('Restore: invalid backup refuses to restore', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Invalid Backup Game' });
  const game = await registerGame(ctx.services, g);
  const created = await ctx.services.backups.create({
    game, targetDir: g.installDir, files: [{ relPath: 'nvngx_dlss.dll' }], operation: { type: 'test' },
  });
  const meta = await ctx.services.backups.getMetadata(game.id, created.backupId);
  // Corrupt the backup copy
  const copyPath = path.join(meta.__dir, meta.modifiedFiles[0].backupRelPath);
  await fsp.appendFile(copyPath, 'corrupted');
  const v = await ctx.services.backups.validate(game.id, created.backupId);
  assert.equal(v.ok, false);
  const res = await ctx.services.backups.restore(game.id, created.backupId);
  assert.equal(res.ok, false);
  assert.ok(res.errors.length);
});

test('Backup: custom backup location from settings is honoured', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const custom = path.join(ctx.dir, 'MyBackups');
  await ctx.services.settings.set({ backupDir: custom });
  const g = await makeFakeGame(ctx.services, { name: 'Custom Location' });
  const game = await registerGame(ctx.services, g);
  const res = await ctx.services.backups.create({
    game, targetDir: g.installDir, files: [{ relPath: 'nvngx_dlss.dll' }], operation: { type: 'test' },
  });
  assert.equal(res.ok, true);
  assert.ok(res.dir.startsWith(custom), `backup went to ${res.dir}`);
});

test('Backup: delete removes one backup only', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Delete Game' });
  const game = await registerGame(ctx.services, g);
  const a = await ctx.services.backups.create({ game, targetDir: g.installDir, files: [], operation: { type: 'test' } });
  const b = await ctx.services.backups.create({ game, targetDir: g.installDir, files: [], operation: { type: 'test' } });
  const del = await ctx.services.backups.delete(game.id, a.backupId);
  assert.equal(del.ok, true);
  const list = await ctx.services.backups.list(game.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].backupId, b.backupId);
});
