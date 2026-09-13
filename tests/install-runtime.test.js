'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { makeTestEnv, makeFakeGame, registerGame, importRuntime, fakeRunner } = require('./helpers');
const { hashFile } = require('../src/core/hash');
const { readFileVersion } = require('../src/core/pe/peVersion');

/** Snapshot a directory: {relPath: sha256}. */
async function snapshotDir(dir) {
  const out = {};
  for (const e of await fsp.readdir(dir)) {
    const p = path.join(dir, e);
    const st = await fsp.stat(p);
    if (st.isFile()) out[e] = await hashFile(p);
    else out[e] = 'dir';
  }
  return out;
}

test('Install: happy path 310.7.129 → 310.9.1 with backup, verification, history, marker', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Swap Game', dlssVersion: '310.7.129' });
  const game = await registerGame(ctx.services, g);
  const before = await snapshotDir(g.installDir);

  const events = [];
  const res = await ctx.services.runtimeInstaller.install(
    { gameId: game.id, version: '310.9.1' },
    (p) => events.push(p)
  );
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.ok(res.backupId);
  assert.ok(res.installedFiles.includes('nvngx_dlss.dll'));
  // optional Streamline files already present are updated too (auto mode)
  assert.ok(res.installedFiles.includes('sl.common.dll'));

  // The installed DLL now reports 310.9.1
  const ver = await readFileVersion(path.join(g.installDir, 'nvngx_dlss.dll'));
  assert.equal(ver.fileVersion, '310.9.1.0');

  // Backup holds the original 310.7.129 file
  const meta = await ctx.services.backups.getMetadata(game.id, res.backupId);
  const restored = await ctx.services.backups.restore(game.id, res.backupId, { dryRun: true });
  assert.equal(restored.ok, true);
  const coreBackup = meta.modifiedFiles.find((f) => f.relPath === 'nvngx_dlss.dll');
  const backupPath = path.join(meta.__dir, coreBackup.backupRelPath);
  const backupVer = await readFileVersion(backupPath);
  assert.equal(backupVer.fileVersion, '310.7.129.0');

  // Marker written
  const marker = JSON.parse(await fsp.readFile(path.join(g.installDir, '.dlss5swapper-marker.json'), 'utf8'));
  const op = marker.operations[marker.operations.length - 1];
  assert.equal(op.type, 'runtime-install');
  assert.equal(op.version, '310.9.1');
  assert.equal(op.fromVersion, '310.7.129.0');

  // History recorded
  const history = await ctx.services.history.list(10, game.id);
  assert.equal(history[0].result, 'success');
  assert.equal(history[0].fromVersion, '310.7.129.0');
  assert.equal(history[0].toVersion, '310.9.1');

  // Progress events covered every step
  const doneSteps = events.filter((e) => e.status === 'done').map((e) => e.stepId);
  for (const s of ['game', 'running', 'conflicts', 'package', 'backup', 'stage', 'install', 'verify']) {
    assert.ok(doneSteps.includes(s), `step ${s} not reported done`);
  }
  void before;
});

test('Install: version switching chain 310.6.0 → 310.7.x → 310.8.x → 310.9.1', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  for (const v of ['310.6.0', '310.7.129', '310.8.0', '310.9.1']) {
    const imp = await importRuntime(ctx.services, v);
    assert.equal(imp.ok, true, `${v}: ${imp.errors.join(';')}`);
  }
  const g = await makeFakeGame(ctx.services, { name: 'Chain Game', dlssVersion: null, withStreamline: false });
  const game = await registerGame(ctx.services, g);
  // Game starts with NO dlss dll at all — first install adds it.
  assert.equal(fs.existsSync(path.join(g.installDir, 'nvngx_dlss.dll')), false);

  const chain = ['310.6.0', '310.7.129', '310.8.0', '310.9.1'];
  let prevVersion = null;
  for (const v of chain) {
    const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: v, optionalFiles: 'required' });
    assert.equal(res.ok, true, `${v}: ${res.error}`);
    assert.equal(res.fromVersion, prevVersion, `${v}: from-version mismatch`);
    const ver = await readFileVersion(path.join(g.installDir, 'nvngx_dlss.dll'));
    assert.equal(ver.fileVersion, `${v}.0`);
    prevVersion = `${v}.0`;
  }
  // Four successful installs, four backups — the very first original state is still restorable.
  const list = await ctx.services.backups.list(game.id);
  assert.equal(list.filter((b) => b.operation.type === 'runtime-install').length, 4);
});

test('Install: missing runtime package fails cleanly, game untouched', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const g = await makeFakeGame(ctx.services, { name: 'Untouched Game' });
  const game = await registerGame(ctx.services, g);
  const before = await snapshotDir(g.installDir);

  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing-package');
  assert.ok(res.error.includes('not in the local library'));
  assert.deepEqual(await snapshotDir(g.installDir), before, 'game folder must be untouched');
  const steps = res.steps.map((s) => [s.id, s.status]);
  assert.ok(steps.some(([id, st]) => id === 'package' && st === 'failed'));
});

test('Install: corrupted package fails validation before touching the game', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.8.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const stored = ctx.services.runtimeLibrary.packageFilePath('310.8.1', 'nvngx_dlss.dll');
  const buf = await fsp.readFile(stored);
  buf[buf.length - 10] ^= 0xff;
  await fsp.writeFile(stored, buf);

  const g = await makeFakeGame(ctx.services, { name: 'Corrupt Pkg Game' });
  const game = await registerGame(ctx.services, g);
  const before = await snapshotDir(g.installDir);
  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.8.1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invalid-package');
  assert.deepEqual(await snapshotDir(g.installDir), before);
});

test('Install: blocked while the game process is running; force overrides', async (t) => {
  const runner = fakeRunner({
    pgrep: () => ({ stdout: '4242\n', stderr: '', code: 0 }),
  });
  const ctx = await makeTestEnv({ runner });
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.0');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Running Game', exeName: 'running.exe' });
  const game = await registerGame(ctx.services, g);

  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.0' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'game-running');
  assert.ok(res.error.includes('currently running'));
  assert.equal(res.processes[0].pid, 4242);

  // Advanced override installs anyway (runner still "sees" the process).
  const forced = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.0', force: true });
  assert.equal(forced.ok, true, forced.error);
});

test('Install: tasklist-based detection on Windows env', async (t) => {
  const runner = fakeRunner({
    reg: () => ({ stdout: '', stderr: '', code: 1 }),
    tasklist: (args) => {
      if (args.some((a) => a.includes('game.exe'))) {
        return { stdout: '"game.exe","1234","Console","1","12,345 K"\n', stderr: '', code: 0 };
      }
      return { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '', code: 0 };
    },
  });
  const ctx = await makeTestEnv({ platform: 'win32', runner });
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Win Game', exeName: 'game.exe' });
  const game = await registerGame(ctx.services, g);
  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'game-running');
});

test('Install: conflict confirmation flow (warning → pause → continue anyway)', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  // Game with an unknown third-party dxgi proxy
  const g = await makeFakeGame(ctx.services, { name: 'Conflict Game', withReShade: false });
  await fsp.writeFile(path.join(g.installDir, 'dxgi.dll'), 'some third party proxy');
  const game = await registerGame(ctx.services, g);

  const first = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1' });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'needs-conflict-confirmation');
  assert.ok(first.conflicts.some((c) => c.file === 'dxgi.dll'));

  const second = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1', skipConflictWarnings: true });
  assert.equal(second.ok, true, second.error);
});

test('Install: refuses early when a target path is a directory (nothing modified)', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Dir Target Game' });
  const game = await registerGame(ctx.services, g);

  // Something put a *directory* where sl.common.dll belongs.
  await fsp.rm(path.join(g.installDir, 'sl.common.dll'));
  await fsp.mkdir(path.join(g.installDir, 'sl.common.dll'));
  const before = await snapshotDir(g.installDir);

  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'target-not-a-file');
  assert.ok(res.error.includes('not a regular file'));
  assert.deepEqual(await snapshotDir(g.installDir), before, 'game folder untouched');
  const list = await ctx.services.backups.list(game.id);
  assert.equal(list.length, 0, 'no backup was even created');
});

test('Install: staging failure after backup rolls back to the exact original state', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.7.0');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Stage Fail Game' });
  const game = await registerGame(ctx.services, g);
  const before = await snapshotDir(g.installDir);

  // Sabotage: make the library hand out the WRONG source file for one entry.
  // Staging re-verifies hashes, catches it, and the installer must roll back
  // to a byte-identical game folder.
  const orig = ctx.services.runtimeLibrary.packageFilePath.bind(ctx.services.runtimeLibrary);
  ctx.services.runtimeLibrary.packageFilePath = (version, name) =>
    name === 'sl.hooks.dll' ? orig(version, 'sl.common.dll') : orig(version, name);

  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.7.0' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'rolled-back');
  assert.equal(res.failedStep, 'stage');
  assert.equal(res.rolledBack, true);

  const after = await snapshotDir(g.installDir);
  for (const [name, hash] of Object.entries(before)) {
    assert.equal(after[name], hash, `${name} differs after rollback`);
  }
  // No staging leftovers
  assert.ok(!(await fsp.readdir(g.installDir)).some((n) => n.startsWith('.dlss5swapper-staging-')));
  // History + backup marked rolled-back
  const history = await ctx.services.history.list(10, game.id);
  assert.equal(history[0].result, 'rolled-back');
  const meta = await ctx.services.backups.getMetadata(game.id, res.backupId);
  assert.equal(meta.result, 'rolled-back');
});

test('Restore flow: full round trip install → restore original', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.9.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Round Trip' });
  const game = await registerGame(ctx.services, g);
  const before = await snapshotDir(g.installDir);

  const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.9.1' });
  assert.equal(res.ok, true, res.error);
  assert.notDeepEqual(await snapshotDir(g.installDir), before);

  const restore = await ctx.services.backups.restore(game.id, res.backupId);
  assert.equal(restore.ok, true, restore.errors.join(';'));
  const after = await snapshotDir(g.installDir);
  for (const [name, hash] of Object.entries(before)) {
    assert.equal(after[name], hash, `${name} not restored to original`);
  }
  // Marker cleaned up after restore
  assert.equal(fs.existsSync(path.join(g.installDir, '.dlss5swapper-marker.json')), false);
});

test('Install: access-denied target reports failure without corrupting the game', async (t) => {
  const ctx = await makeTestEnv();
  t.after(ctx.cleanup);
  const imp = await importRuntime(ctx.services, '310.6.1');
  assert.equal(imp.ok, true, imp.errors.join(';'));
  const g = await makeFakeGame(ctx.services, { name: 'Locked Game' });
  const game = await registerGame(ctx.services, g);
  // Make the game folder read-only → staging dir creation fails
  await fsp.chmod(g.installDir, 0o555);
  try {
    const res = await ctx.services.runtimeInstaller.install({ gameId: game.id, version: '310.6.1' });
    assert.equal(res.ok, false);
    // Backup existed, rollback ran (nothing to undo)
    assert.ok(['rolled-back', 'stage-failed', 'install-failed'].includes(res.code));
  } finally {
    await fsp.chmod(g.installDir, 0o755);
  }
  const ver = await readFileVersion(path.join(g.installDir, 'nvngx_dlss.dll'));
  assert.equal(ver.fileVersion, '310.7.129.0', 'original file intact');
});
