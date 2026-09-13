'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;

/**
 * Hashing utilities. SHA-256 everywhere: runtime manifests, backups,
 * verification after install, and identifying injected builds (some mod
 * authors ship two builds with identical version resources — hashes tell
 * them apart).
 */

/** Stream-hash a file. Resolves to lowercase hex digest. */
function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Hash an in-memory buffer. */
function hashBuffer(buffer, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

/**
 * Verify a file against an expected SHA-256.
 * @returns {Promise<{ok:boolean, actual:string|null, expected:string|null, reason?:string}>}
 */
async function verifyFileHash(filePath, expectedSha256) {
  if (!expectedSha256) return { ok: true, actual: null, expected: null, reason: 'no-hash-on-record' };
  try {
    const actual = await hashFile(filePath);
    if (actual.toLowerCase() === String(expectedSha256).toLowerCase()) {
      return { ok: true, actual, expected: expectedSha256 };
    }
    return { ok: false, actual, expected: expectedSha256, reason: 'hash-mismatch' };
  } catch (err) {
    return { ok: false, actual: null, expected: expectedSha256, reason: `read-error: ${err.message}` };
  }
}

/** stat a file, returning null instead of throwing when missing. */
async function tryStat(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

module.exports = { hashFile, hashBuffer, verifyFileHash, tryStat };
