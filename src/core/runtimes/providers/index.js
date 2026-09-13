'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * Runtime source providers.
 *
 *   ProviderRegistry
 *   ├── local      — packages already in the Runtime Library
 *   ├── github     — release assets from configured GitHub repositories
 *   └── import     — manual user import (handled by RuntimeLibrary.importPackage)
 *
 * Providers only ever place files into the library (validated + hashed);
 * installation never talks to a provider directly. Adding a future online
 * provider means adding one class here and registering it — nothing else
 * changes.
 */

class ProviderRegistry {
  /**
   * @param {import('../../env').AppEnv} env
   * @param {import('../../logger').Logger} logger
   * @param {import('../library').RuntimeLibrary} library
   * @param {import('../manifests').ManifestStore} manifests
   * @param {import('../../settings').SettingsService} settings
   */
  constructor(env, logger, library, manifests, settings) {
    this.env = env;
    this.logger = logger;
    this.library = library;
    this.manifests = manifests;
    this.settings = settings;
    this.providers = [
      {
        id: 'github',
        name: 'GitHub Releases',
        description: 'Downloads runtime files from release assets of configured GitHub repositories.',
        instance: new GitHubProvider(env, logger, manifests, settings, library),
      },
    ];
  }

  list() {
    return [
      { id: 'local', name: 'Local Package', description: 'Packages already imported into your Runtime Library.' },
      ...this.providers.map((p) => ({ id: p.id, name: p.name, description: p.description })),
      { id: 'import', name: 'User Import', description: 'Manually import runtime files you obtained from a legitimate source.' },
    ];
  }

  /**
   * Try to download a runtime version through the enabled providers.
   * @param {string} version
   * @param {string[]} [providerIds] Restrict to specific providers (default: all enabled).
   * @param {(p:{phase:string, detail?:string, percent?:number})=>void} [onProgress]
   */
  async download(version, providerIds, onProgress = () => {}) {
    const rt = await this.manifests.get(version);
    if (!rt) return { ok: false, errors: [`Unknown runtime version ${version}.`], warnings: [] };

    const settings = await this.settings.get();
    const attempts = [];
    const warnings = [];
    for (const p of this.providers) {
      if (providerIds && providerIds.length && !providerIds.includes(p.id)) continue;
      const providerSettings = (settings.runtimeSources || {})[p.id];
      if (providerSettings && providerSettings.enabled === false) {
        attempts.push({ provider: p.id, ok: false, skipped: 'disabled in Options → Runtime sources' });
        continue;
      }
      try {
        onProgress({ phase: 'provider', detail: `Trying ${p.name}…` });
        const res = await p.instance.download(version, rt, (sub) => onProgress({ ...sub, provider: p.id }));
        attempts.push({ provider: p.id, ...res });
        if (res.ok) {
          onProgress({ phase: 'done', detail: `Runtime ${version} downloaded into the library.` });
          return { ok: true, provider: p.id, package: res.package, attempts, warnings: [...warnings, ...(res.warnings || [])] };
        }
        warnings.push(...(res.warnings || []));
      } catch (err) {
        attempts.push({ provider: p.id, ok: false, error: err.message });
        await this.logger.errorObj(`Provider ${p.id} failed for ${version}`, err);
      }
    }
    const errors = attempts.map((a) => `${a.provider}: ${a.error || a.skipped || 'no usable source'}`);
    errors.push('Automatic download failed. You can still import the runtime files manually (Runtimes page → Import).');
    return { ok: false, errors, warnings, attempts };
  }
}

/**
 * GitHubProvider — fetches release assets using URL templates with
 * {version} / {file} placeholders, from settings and/or the manifest entry.
 */
class GitHubProvider {
  constructor(env, logger, manifests, settings, library) {
    this.env = env;
    this.logger = logger;
    this.manifests = manifests;
    this.settings = settings;
    this._library = library;
  }

  async download(version, rt, onProgress = () => {}) {
    const settings = await this.settings.get();
    const templates = [];
    for (const src of rt.sources || []) {
      if (src.provider === 'github' && src.url) templates.push(src.url);
    }
    const gh = (settings.runtimeSources || {}).github;
    if (gh && gh.enabled !== false) templates.push(...(gh.repos || []));
    if (!templates.length) {
      return { ok: false, error: 'no GitHub source templates configured', warnings: [] };
    }

    const warnings = [];
    const tmpDir = path.join(this.env.paths.staging, `gh-${version}-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    const downloaded = [];
    try {
      for (const fileDef of rt.files) {
        let got = false;
        for (const template of templates) {
          const url = template.replace(/\{version\}/g, version).replace(/\{file\}/g, fileDef.name);
          onProgress({ phase: 'download', detail: `${fileDef.name} ← ${url}`, percent: null });
          const dest = path.join(tmpDir, fileDef.name);
          const res = await fetchUrlToFile(url, dest, (pct) =>
            onProgress({ phase: 'download', detail: `${fileDef.name} ${pct}%`, percent: pct })
          );
          if (res.ok) {
            if (fileDef.sha256) {
              const { hashFile } = require('../../hash');
              const actual = await hashFile(dest);
              if (actual !== fileDef.sha256) {
                warnings.push(`${fileDef.name}: downloaded hash does not match manifest hash — discarded.`);
                await fsp.unlink(dest).catch(() => {});
                continue;
              }
            }
            downloaded.push(dest);
            got = true;
            break;
          }
          if (res.status === 404) continue; // try next template
          warnings.push(`${fileDef.name}: ${url} → HTTP ${res.status}`);
        }
        if (!got && fileDef.required) {
          await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          return {
            ok: false,
            error: `required file ${fileDef.name} could not be downloaded from any configured source`,
            warnings,
          };
        }
      }
      if (!downloaded.length) {
        return { ok: false, error: 'no files found at configured sources', warnings };
      }
      // Import through the library so validation/hashing rules apply uniformly.
      const lib = this._library;
      const res = await lib.importPackage({ version, filePaths: downloaded, origin: 'provider:github' });
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (!res.ok) return { ok: false, error: res.errors.join('; '), warnings: [...warnings, ...res.warnings] };
      await this.logger.success(`Runtime ${version} downloaded via GitHub provider`);
      return { ok: true, package: res.package, warnings: [...warnings, ...res.warnings] };
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: err.message, warnings };
    }
  }
}

/** fetch a URL to a file with basic progress. Returns {ok, status}. */
async function fetchUrlToFile(url, dest, onPercent) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      out.write(chunk);
      if (total && onPercent) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        if (pct !== lastPct && pct % 5 === 0) { onPercent(pct); lastPct = pct; }
      }
    }
  } finally {
    out.end();
    await new Promise((r) => out.once('close', r));
  }
  await fsp.rename(tmp, dest);
  return { ok: true, status: res.status, bytes: received };
}

module.exports = { ProviderRegistry, GitHubProvider, fetchUrlToFile };
