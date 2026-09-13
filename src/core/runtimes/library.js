'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../hash');
const { readFileVersion } = require('../pe/peVersion');
const { compareVersions } = require('../../shared/format');
const { FILE_ROLES } = require('../../shared/constants');

/**
 * RuntimeLibrary — the local store of actual runtime package files.
 *
 * Layout:  <dataDir>/RuntimeLibrary/<version>/
 *            package.json     (metadata: origin, files with hashes/sizes)
 *            files/<name>...  (the DLLs / configs themselves)
 *
 * Packages arrive via user import or a download provider. A package is only
 * considered complete when every file the manifest marks `required` is
 * present. Nothing is ever installed straight from a user folder: files are
 * copied into the library, hashed and validated first.
 */
class RuntimeLibrary {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   * @param {import('./manifests').ManifestStore} manifests
   */
  constructor(env, logger, manifests) {
    this.env = env;
    this.logger = logger;
    this.manifests = manifests;
    this.root = env.paths.runtimeLibrary;
  }

  packageDir(version) {
    return path.join(this.root, version);
  }

  filesDir(version) {
    return path.join(this.packageDir(version), 'files');
  }

  metaPath(version) {
    return path.join(this.packageDir(version), 'package.json');
  }

  /** Read a stored package's metadata, or null when absent/corrupt. */
  async getPackage(version) {
    try {
      const meta = JSON.parse(await fsp.readFile(this.metaPath(version), 'utf8'));
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * List library state for every manifest version.
   * @returns {Promise<Array<object>>} [{version, available, complete, package, missing}]
   */
  async listAvailability() {
    const runtimes = await this.manifests.list();
    const out = [];
    for (const rt of runtimes) {
      const pkg = await this.getPackage(rt.version);
      const required = rt.files.filter((f) => f.required).map((f) => f.name);
      const have = new Set((pkg && pkg.files ? pkg.files : []).map((f) => f.name));
      const missing = required.filter((n) => !have.has(n));
      out.push({
        version: rt.version,
        available: !!pkg,
        complete: !!pkg && missing.length === 0,
        missing,
        origin: pkg ? pkg.origin : null,
        importedAt: pkg ? pkg.importedAt : null,
        fileCount: pkg && pkg.files ? pkg.files.length : 0,
        package: pkg,
        runtime: rt,
      });
    }
    return out;
  }

  /**
   * Import a runtime package from a user-selected folder (or list of files).
   *
   * Steps (per spec): validate filenames → validate structure → hash →
   * read PE version metadata where possible → store metadata.
   *
   * @param {object} opts
   * @param {string} opts.version   Target runtime version from the manifest DB.
   * @param {string[]} opts.filePaths Files to import (already selected by the user).
   * @param {string} [opts.origin]  'user-import' (default) | 'provider' | 'demo'.
   * @param {boolean} [opts.allowVersionMismatch] Advanced: keep package even if PE
   *        version resource disagrees with the declared version.
   * @returns {Promise<{ok:boolean, package?:object, errors:string[], warnings:string[]}>}
   */
  async importPackage({ version, filePaths, origin = 'user-import', allowVersionMismatch = false }) {
    const errors = [];
    const warnings = [];
    const rt = await this.manifests.get(version);
    if (!rt) {
      return { ok: false, errors: [`Version ${version} is not in the runtime manifest database.`], warnings };
    }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { ok: false, errors: ['No files selected for import.'], warnings };
    }

    const knownNames = new Set(rt.files.map((f) => f.name));
    const requiredNames = rt.files.filter((f) => f.required).map((f) => f.name);

    // 1. Validate every candidate file exists and is a file.
    const candidates = [];
    for (const p of filePaths) {
      const stat = await fsp.stat(p).catch(() => null);
      if (!stat || !stat.isFile()) {
        errors.push(`Not a readable file: ${p}`);
        continue;
      }
      const name = path.basename(p);
      if (!knownNames.has(name)) {
        warnings.push(`"${name}" is not part of runtime ${version} and was skipped.`);
        continue;
      }
      candidates.push({ path: p, name, sizeBytes: stat.size });
    }

    const haveNames = new Set(candidates.map((c) => c.name));
    for (const req of requiredNames) {
      if (!haveNames.has(req)) {
        errors.push(`Required file "${req}" for runtime ${version} is missing from the import.`);
      }
    }
    if (errors.length) return { ok: false, errors, warnings };

    // 2. Hash + version-inspect each candidate.
    const files = [];
    for (const c of candidates) {
      const sha256 = await hashFile(c.path);
      const entry = {
        name: c.name,
        role: (rt.files.find((f) => f.name === c.name) || {}).role || FILE_ROLES.OTHER,
        required: requiredNames.includes(c.name),
        sha256,
        sizeBytes: c.sizeBytes,
        detectedVersion: null,
      };
      if (/\.dll$/i.test(c.name)) {
        const ver = await readFileVersion(c.path);
        if (ver && !ver.error) {
          entry.detectedVersion = ver.fileVersion || ver.productVersion || null;
          const declared = rt.dlssVersion || rt.version;
          // Compare the first three segments; build numbers (e.g. .129) vary.
          const norm = (v) => String(v).split('.').slice(0, 3).join('.');
          if (entry.role === FILE_ROLES.DLSS_CORE && entry.detectedVersion && norm(entry.detectedVersion) !== norm(declared)) {
            const msg = `"${c.name}" reports version ${entry.detectedVersion} but runtime ${version} expects ${declared}.`;
            if (allowVersionMismatch) warnings.push(msg + ' Imported anyway (version-mismatch override).');
            else errors.push(msg + ' Enable Advanced Mode override to import anyway.');
          }
        } else {
          warnings.push(`"${c.name}" has no readable PE version resource; identity will rely on its hash.`);
        }
      }
      files.push(entry);
    }
    if (errors.length) return { ok: false, errors, warnings };

    // 3. Copy into the library (atomic-ish: write into temp dir, then swap).
    const pkgDir = this.packageDir(version);
    const filesDir = this.filesDir(version);
    const tmpDir = path.join(this.env.paths.staging, `lib-import-${version}-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      for (const f of files) {
        const src = candidates.find((c) => c.name === f.name).path;
        const dest = path.join(tmpDir, f.name);
        await fsp.copyFile(src, dest);
        const check = await hashFile(dest);
        if (check !== f.sha256) {
          throw new Error(`Copy of "${f.name}" failed hash verification.`);
        }
      }
      const meta = {
        schemaVersion: 1,
        version,
        dlssVersion: rt.dlssVersion || rt.version,
        streamlineVersion: rt.streamlineVersion || null,
        origin,
        importedAt: new Date().toISOString(),
        complete: requiredNames.every((n) => files.some((f) => f.name === n)),
        files,
      };
      await fsp.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(meta, null, 2), 'utf8');

      // Swap into place: remove old package only after the new one is staged.
      if (fs.existsSync(pkgDir)) await fsp.rm(pkgDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(pkgDir), { recursive: true });
      await fsp.rename(tmpDir, pkgDir);
      await fsp.mkdir(filesDir, { recursive: true });
      // Move files from package root into files/ subdir (rename keeps hashes valid).
      for (const f of files) {
        const from = path.join(pkgDir, f.name);
        const to = path.join(filesDir, f.name);
        if (fs.existsSync(from)) await fsp.rename(from, to);
      }
      await this.logger.success(`Runtime ${version} imported into library (${files.length} file(s), origin: ${origin})`);
      return { ok: true, package: meta, errors, warnings };
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await this.logger.errorObj(`Runtime ${version} import failed`, err);
      return { ok: false, errors: [...errors, err.message], warnings };
    }
  }

  /**
   * Validate a stored package before installation:
   * files exist on disk and hashes still match package.json.
   */
  async validatePackage(version) {
    const pkg = await this.getPackage(version);
    if (!pkg) return { ok: false, reason: 'missing-package', detail: `Runtime ${version} is not in the local library. Import or download it first.` };
    const problems = [];
    for (const f of pkg.files || []) {
      const p = path.join(this.filesDir(version), f.name);
      const stat = await fsp.stat(p).catch(() => null);
      if (!stat) { problems.push(`File missing from package: ${f.name}`); continue; }
      if (f.sizeBytes != null && stat.size !== f.sizeBytes) problems.push(`Size mismatch for ${f.name}`);
      if (f.sha256) {
        const actual = await hashFile(p);
        if (actual !== f.sha256) problems.push(`Hash mismatch for ${f.name} (package may be corrupted)`);
      }
    }
    const rt = await this.manifests.get(version);
    if (rt) {
      const have = new Set((pkg.files || []).map((f) => f.name));
      for (const req of rt.files.filter((f) => f.required)) {
        if (!have.has(req.name)) problems.push(`Required file ${req.name} not in package`);
      }
    }
    return problems.length === 0
      ? { ok: true, package: pkg }
      : { ok: false, reason: 'invalid-package', detail: problems.join('; '), problems };
  }

  /** Absolute source path of a file inside a stored package. */
  packageFilePath(version, fileName) {
    return path.join(this.filesDir(version), fileName);
  }

  /** Delete a stored package. */
  async deletePackage(version) {
    const dir = this.packageDir(version);
    if (!fs.existsSync(dir)) return { ok: false, reason: 'not-found' };
    await fsp.rm(dir, { recursive: true, force: true });
    await this.logger.info(`Runtime package ${version} deleted from library`);
    return { ok: true };
  }

  /** Known hashes for a file name across the library (used by the analyzer). */
  async hashIndex() {
    const index = new Map(); // sha256 -> {version, name, role}
    let entries = [];
    try {
      entries = await fsp.readdir(this.root);
    } catch {
      return index;
    }
    for (const version of entries) {
      const pkg = await this.getPackage(version);
      if (!pkg) continue;
      for (const f of pkg.files || []) {
        if (f.sha256) index.set(f.sha256.toLowerCase(), { version: pkg.version, name: f.name, role: f.role });
      }
    }
    return index;
  }
}

module.exports = { RuntimeLibrary };
void compareVersions; // kept for future sorting helpers within this module
