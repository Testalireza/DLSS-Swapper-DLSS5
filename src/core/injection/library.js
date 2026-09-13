'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../hash');
const { readFileVersion } = require('../pe/peVersion');
const { makeId } = require('../../shared/format');
const { FILE_ROLES, INJECTION_METHODS } = require('../../shared/constants');

/**
 * InjectionLibrary — manages DLSS 5 Neural Rendering injection packages.
 *
 * Layout:  <dataDir>/InjectionLibrary/<injectionId>/
 *            injection.json   (metadata: name, methods, file roles, install map)
 *            files/<name>...  (the binaries/configs themselves)
 *
 * The architecture deliberately does NOT hardcode one specific patched
 * binary: a package declares which methods it supports, what each file's role
 * is, how it should be installed (optionally renamed) and which config
 * directives to ensure. Anything the user legitimately obtains can be
 * imported and managed.
 */

/** Roles that count as "the injection itself" (at least one required). */
const CORE_ROLES = new Set([FILE_ROLES.INJECTION_CORE, FILE_ROLES.INJECTION_ADDON, FILE_ROLES.DLSS_CORE, FILE_ROLES.PROXY]);

class InjectionLibrary {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   */
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.root = env.paths.injectionLibrary;
  }

  packageDir(id) { return path.join(this.root, id); }
  filesDir(id) { return path.join(this.packageDir(id), 'files'); }
  metaPath(id) { return path.join(this.packageDir(id), 'injection.json'); }

  async get(id) {
    try {
      return JSON.parse(await fsp.readFile(this.metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async list() {
    let entries = [];
    try { entries = await fsp.readdir(this.root); } catch { return []; }
    const out = [];
    for (const e of entries.sort()) {
      const meta = await this.get(e);
      if (meta) out.push(meta);
    }
    return out;
  }

  /**
   * Import injection files.
   *
   * @param {object} opts
   * @param {string[]} opts.filePaths  Files selected by the user.
   * @param {string} [opts.name]       Display name (default: derived from files).
   * @param {string[]} [opts.methods]  Supported methods (default: auto-detected).
   * @param {Array<{name:string, installAs?:string, role?:string}>} [opts.fileOverrides]
   *        Per-file role/rename overrides from the import dialog.
   * @param {Array<{file:string, section:string, key:string, value:string, mode?:'ensure-csv'|'set-if-missing'}>} [opts.configDirectives]
   */
  async importPackage(opts) {
    const errors = [];
    const warnings = [];
    const overrides = new Map((opts.fileOverrides || []).map((o) => [path.basename(o.name).toLowerCase(), o]));

    const candidates = [];
    for (const p of opts.filePaths || []) {
      const stat = await fsp.stat(p).catch(() => null);
      if (!stat || !stat.isFile()) { errors.push(`Not a readable file: ${p}`); continue; }
      candidates.push({ path: p, name: path.basename(p), sizeBytes: stat.size });
    }
    if (!candidates.length) return { ok: false, errors: errors.length ? errors : ['No files selected.'], warnings };

    // Classify each file (user overrides win).
    const files = [];
    for (const c of candidates) {
      const ov = overrides.get(c.name.toLowerCase()) || {};
      const role = ov.role || InjectionLibrary.guessRole(c.name);
      const entry = {
        name: c.name,
        role,
        installAs: ov.installAs && ov.installAs.trim() ? ov.installAs.trim() : c.name,
        sha256: await hashFile(c.path),
        sizeBytes: c.sizeBytes,
        detectedVersion: null,
      };
      if (/\.dll$/i.test(c.name)) {
        const ver = await readFileVersion(c.path);
        if (ver && !ver.error) entry.detectedVersion = ver.fileVersion || null;
      }
      if (CORE_ROLES.has(role) && /\.addon32$/i.test(c.name)) warnings.push(`"${c.name}" is a 32-bit add-on; most games are 64-bit.`);
      files.push(entry);
    }

    if (!files.some((f) => CORE_ROLES.has(f.role))) {
      errors.push('None of the selected files were recognised as an injection core/add-on/proxy file. ' +
        'Assign a role manually in the import dialog (Advanced Mode).');
    }

    // Methods: explicit or guessed from file names.
    let methods = opts.methods && opts.methods.length ? opts.methods : InjectionLibrary.guessMethods(files);
    if (!methods.length) {
      warnings.push('Could not determine injection method(s); defaulting to both OptiScaler and ReShade. ' +
        'Edit the package after import if only one applies.');
      methods = [INJECTION_METHODS.OPTISCALER, INJECTION_METHODS.RESHADE];
    }

    if (errors.length) return { ok: false, errors, warnings };

    const id = `inj-${Date.now().toString(36)}-${makeId().slice(-4)}`;
    const pkgDir = this.packageDir(id);
    const tmpDir = path.join(this.env.paths.staging, `inj-import-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      for (let i = 0; i < files.length; i++) {
        const dest = path.join(tmpDir, files[i].name);
        await fsp.copyFile(candidates[i].path, dest);
        const check = await hashFile(dest);
        if (check !== files[i].sha256) throw new Error(`Copy of "${files[i].name}" failed hash verification.`);
      }
      const meta = {
        schemaVersion: 1,
        id,
        name: opts.name && opts.name.trim() ? opts.name.trim() : InjectionLibrary.deriveName(files),
        description: opts.description || null,
        methods,
        importedAt: new Date().toISOString(),
        origin: opts.origin || 'user-import',
        files,
        configDirectives: Array.isArray(opts.configDirectives) ? opts.configDirectives : [],
      };
      await fsp.writeFile(path.join(tmpDir, 'injection.json'), JSON.stringify(meta, null, 2), 'utf8');
      if (fs.existsSync(pkgDir)) await fsp.rm(pkgDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(pkgDir), { recursive: true });
      await fsp.rename(tmpDir, pkgDir);
      await fsp.mkdir(this.filesDir(id), { recursive: true });
      for (const f of files) {
        const from = path.join(pkgDir, f.name);
        if (fs.existsSync(from)) await fsp.rename(from, path.join(this.filesDir(id), f.name));
      }
      await this.logger.success(`Injection package imported: ${meta.name} (${files.length} file(s), methods: ${methods.join(', ')})`);
      return { ok: true, package: meta, errors, warnings };
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await this.logger.errorObj('Injection import failed', err);
      return { ok: false, errors: [...errors, err.message], warnings };
    }
  }

  /** Update metadata of an existing package (name, methods, roles, directives). */
  async updatePackage(id, patch) {
    const meta = await this.get(id);
    if (!meta) return { ok: false, error: 'unknown-injection' };
    const updated = { ...meta, ...patch, id: meta.id, importedAt: meta.importedAt };
    await fsp.writeFile(this.metaPath(id), JSON.stringify(updated, null, 2), 'utf8');
    return { ok: true, package: updated };
  }

  async delete(id) {
    const dir = this.packageDir(id);
    if (!fs.existsSync(dir)) return { ok: false, reason: 'not-found' };
    await fsp.rm(dir, { recursive: true, force: true });
    await this.logger.info(`Injection package deleted: ${id}`);
    return { ok: true };
  }

  filePath(id, fileName) {
    return path.join(this.filesDir(id), fileName);
  }

  /** Hash → {injectionId, file} lookup used to recognise installed injections. */
  async hashIndex() {
    const index = new Map();
    for (const meta of await this.list()) {
      for (const f of meta.files || []) {
        if (f.sha256) index.set(f.sha256.toLowerCase(), { injectionId: meta.id, injectionName: meta.name, file: f.name });
      }
    }
    return index;
  }

  static guessRole(fileName) {
    const n = fileName.toLowerCase();
    if (/\.addon(64|32)$/.test(n)) return FILE_ROLES.INJECTION_ADDON;
    if (n === 'nvngx_dlss.dll') return FILE_ROLES.DLSS_CORE;
    if (n === 'nvngx_dlssg.dll') return FILE_ROLES.DLSS_FRAMEGEN;
    if (n === 'nvngx_dlssd.dll') return FILE_ROLES.DLSS_RAYRECON;
    if (['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d9.dll', 'winmm.dll', 'nvngx.dll', 'vulkan-1.dll', 'opengl32.dll', 'ddraw.dll', 'version.dll'].includes(n)) return FILE_ROLES.PROXY;
    if (n.endsWith('.ini') || n.endsWith('.json') || n.endsWith('.cfg')) return FILE_ROLES.CONFIG;
    if (n.endsWith('.dll')) return FILE_ROLES.INJECTION_CORE;
    return FILE_ROLES.OTHER;
  }

  static guessMethods(files) {
    const methods = new Set();
    const names = files.map((f) => f.name.toLowerCase());
    if (names.some((n) => n.endsWith('.addon64') || n.endsWith('.addon32'))) methods.add(INJECTION_METHODS.RESHADE);
    if (names.some((n) => n === 'nvngx.dll' || n === 'dxgi.dll' || n === 'winmm.dll' || n === 'optiscaler.ini')) methods.add(INJECTION_METHODS.OPTISCALER);
    if (names.some((n) => n === 'nvngx_dlss.dll')) {
      methods.add(INJECTION_METHODS.OPTISCALER);
      methods.add(INJECTION_METHODS.RESHADE);
    }
    return [...methods];
  }

  static deriveName(files) {
    const core = files.find((f) => CORE_ROLES.has(f.role));
    return core ? core.name.replace(/\.(dll|addon64|addon32)$/i, '') : 'Unnamed Injection';
  }
}

module.exports = { InjectionLibrary, CORE_ROLES };
