'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile, verifyFileHash } = require('../hash');
const { makeId } = require('../../shared/format');
const { APP } = require('../../shared/constants');

/**
 * Safe file operations — the spec's preferred workflow:
 *
 *   1. Validate          (caller: package validated, backup created)
 *   2. Copy to staging   (inside the target folder → same volume → atomic renames)
 *   3. Validate staged   (hash + size)
 *   4. Replace target    (rename over target; fallback copy+verify)
 *   5. Verify target     (hash + size + optional PE version)
 *   6. Cleanup / report
 *
 * Anything that fails leaves the caller with a precise list of what was and
 * wasn't touched so it can roll back from the backup.
 */

/**
 * Stage files for installation.
 * @param {object} opts
 * @param {string} opts.targetDir
 * @param {Array<{sourcePath:string, fileName:string, sha256:string, sizeBytes?:number}>} opts.operations
 * @returns {Promise<{ok:boolean, stagingDir?:string, staged?:Array, error?:string}>}
 */
async function stageFiles({ targetDir, operations }) {
  const stagingDir = path.join(targetDir, `.dlss5swapper-staging-${makeId()}`);
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
    const staged = [];
    for (const op of operations) {
      if (!fs.existsSync(op.sourcePath)) {
        throw new Error(`Source file missing from runtime package: ${op.sourcePath}`);
      }
      const stagedPath = path.join(stagingDir, op.fileName);
      await fsp.copyFile(op.sourcePath, stagedPath);
      // Validate the staged copy before anything in the game folder changes.
      const check = await verifyFileHash(stagedPath, op.sha256);
      if (!check.ok) throw new Error(`Staged copy of ${op.fileName} failed hash verification (${check.reason}).`);
      if (op.sizeBytes != null) {
        const stat = await fsp.stat(stagedPath);
        if (stat.size !== op.sizeBytes) throw new Error(`Staged copy of ${op.fileName} has unexpected size (${stat.size} ≠ ${op.sizeBytes}).`);
      }
      staged.push({ ...op, stagedPath });
    }
    return { ok: true, stagingDir, staged };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/**
 * Commit staged files onto their targets.
 * Returns per-file results; `committed` lists what actually changed (used for
 * rollback bookkeeping).
 */
async function commitStaged({ staged, targetDir }) {
  const committed = [];
  const errors = [];
  for (const op of staged) {
    const targetPath = path.isAbsolute(op.fileName) ? op.fileName : path.join(targetDir, op.fileName);
    try {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      let usedFallback = false;
      try {
        await fsp.rename(op.stagedPath, targetPath);
      } catch (renameErr) {
        // Cross-device or permission oddity: copy + verify + replace.
        usedFallback = true;
        const tmp = `${targetPath}.dlss5tmp-${Date.now()}`;
        await fsp.copyFile(op.stagedPath, tmp);
        const check = await verifyFileHash(tmp, op.sha256);
        if (!check.ok) {
          await fsp.unlink(tmp).catch(() => {});
          throw new Error(`Fallback copy of ${op.fileName} failed verification (${check.reason}). Original file untouched. (${renameErr.message})`);
        }
        await fsp.rename(tmp, targetPath);
        await fsp.unlink(op.stagedPath).catch(() => {});
      }
      // Verify the live target.
      const check = await verifyFileHash(targetPath, op.sha256);
      if (!check.ok) throw new Error(`Post-install verification failed for ${op.fileName} (${check.reason}).`);
      committed.push({ ...op, targetPath, usedFallback });
    } catch (err) {
      errors.push({ fileName: op.fileName, targetPath, error: err.message });
    }
  }
  return { ok: errors.length === 0, committed, errors };
}

/** Remove a staging directory (best effort). */
async function cleanupStaging(stagingDir) {
  if (!stagingDir) return;
  await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Roll back a partially/fully committed install:
 *  - files we ADDED (no original) are deleted, but only while their hash still
 *    matches what we installed;
 *  - files we REPLACED are restored by the caller via BackupService.restore.
 * Returns the list of deletions performed / skipped.
 */
async function removeInstalledFiles({ committed, targetDir }) {
  const removed = [];
  const kept = [];
  for (const op of committed || []) {
    const targetPath = op.targetPath || path.join(targetDir, op.fileName);
    try {
      if (!fs.existsSync(targetPath)) { removed.push(op.fileName); continue; }
      const current = await hashFile(targetPath);
      if (current === op.sha256) {
        await fsp.unlink(targetPath);
        removed.push(op.fileName);
      } else {
        kept.push({ fileName: op.fileName, reason: 'file changed after install — kept for safety' });
      }
    } catch (err) {
      kept.push({ fileName: op.fileName, reason: err.message });
    }
  }
  return { removed, kept };
}

/**
 * Append an operation record to the app marker file in the target dir.
 * The marker is how the analyzer recognises "we did this" later.
 */
async function writeMarker(targetDir, operation) {
  const markerPath = path.join(targetDir, APP.markerFileName);
  let marker = { schemaVersion: 1, app: APP.name, appVersion: APP.version, operations: [] };
  try {
    marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    if (!Array.isArray(marker.operations)) marker.operations = [];
  } catch { /* fresh marker */ }
  marker.operations.push(operation);
  await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  return markerPath;
}

/**
 * Detect whether a target file is locked/in use (best-effort): try opening it
 * for append. On Windows, files mapped by a running process refuse this.
 */
async function isFileLocked(filePath) {
  try {
    const fh = await fsp.open(filePath, 'r+');
    await fh.close();
    return false;
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
  }
}

module.exports = { stageFiles, commitStaged, cleanupStaging, removeInstalledFiles, writeMarker, isFileLocked };
