'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../hash');
const { readFileVersion, parsePeHeaders, parsePeImports } = require('../pe/peVersion');
const { detectReShade } = require('../injection/reshade');
const { detectOptiScaler } = require('../injection/optiscaler');
const { DLSS_FILES, STREAMLINE_PLUGIN_PATTERN, PROXY_DLLS, APP } = require('../../shared/constants');

/**
 * GameAnalyzer — inspects one game install and produces the analysis object
 * the UI renders: executable, graphics API, DLSS/Streamline presence and
 * versions, injection status, bitness.
 *
 * Version detection priority (per spec: don't rely on file names):
 *   1. PE version resource of the DLL itself
 *   2. SHA-256 match against the local Runtime Library hash index
 *   3. "unknown" — reported honestly
 */

const SKIP_DIRS = new Set([
  'node_modules', '__redist', '_commonredist', '_installer', 'redist', 'directx',
  'vcredist', '$recycle.bin', 'system volume information', '.git',
  'easyanticheat', 'battleye', 'eos', 'crashreports', 'engine',
]);

const BAD_EXE_PATTERNS = /(unins\d*|uninstall|setup|redist|vcredist|dxsetup|dotnet|prereq|crash|reporter|bugreport|benchmark|launcher|updater|patcher|cleanup|verify|diagnostic)/i;

const API_IMPORT_MAP = [
  { dll: 'd3d12.dll', api: 'DirectX 12' },
  { dll: 'd3d12core.dll', api: 'DirectX 12' },
  { dll: 'd3d11.dll', api: 'DirectX 11' },
  { dll: 'd3d10.dll', api: 'DirectX 10' },
  { dll: 'd3d9.dll', api: 'DirectX 9' },
  { dll: 'd3d8.dll', api: 'DirectX 8' },
  { dll: 'vulkan-1.dll', api: 'Vulkan' },
  { dll: 'opengl32.dll', api: 'OpenGL' },
];

class GameAnalyzer {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   * @param {import('../runtimes/library').RuntimeLibrary} runtimeLibrary
   * @param {import('../injection/library').InjectionLibrary} injectionLibrary
   */
  constructor(env, logger, runtimeLibrary, injectionLibrary) {
    this.env = env;
    this.logger = logger;
    this.runtimeLibrary = runtimeLibrary;
    this.injectionLibrary = injectionLibrary;
  }

  /**
   * Analyze a game record from GameStore.
   * @param {object} game
   * @returns {Promise<object>} analysis
   */
  async analyze(game) {
    const analysis = {
      gameId: game.id,
      name: game.name,
      provider: game.provider,
      installDir: game.installDir,
      analyzedAt: new Date().toISOString(),
      ok: true,
      errors: [],
      executable: null,
      executableCandidates: [],
      targetDir: null,
      graphicsApi: [],
      is64bit: null,
      dlss: { detected: false, files: [], primaryVersion: null },
      streamline: { detected: false, files: [], version: null },
      injection: { installed: false, method: null, injectionName: null, details: null },
      reshade: null,
      optiscaler: null,
      marker: null,
    };

    if (!game.installDir || !fs.existsSync(game.installDir)) {
      analysis.ok = false;
      analysis.errors.push(`Install folder does not exist: ${game.installDir}`);
      return analysis;
    }

    const runtimeHashIndex = await this.runtimeLibrary.hashIndex().catch(() => new Map());
    const injectionHashIndex = await this.injectionLibrary.hashIndex().catch(() => new Map());

    // 1. Executable candidates
    const candidates = await this._findExecutables(game.installDir);
    analysis.executableCandidates = candidates.map((c) => c.path);
    const chosen = this._chooseExecutable(candidates, game);
    if (chosen) {
      analysis.executable = { path: chosen.path, name: path.basename(chosen.path), score: chosen.score, reasons: chosen.reasons };
      analysis.targetDir = path.dirname(chosen.path);
      try {
        const buf = await fsp.readFile(chosen.path);
        const headers = parsePeHeaders(buf);
        analysis.is64bit = headers.is64bit;
        // 2. Graphics API from real PE imports
        const imports = parsePeImports(buf);
        const apis = [];
        for (const imp of imports) {
          const hit = API_IMPORT_MAP.find((m) => m.dll === imp);
          if (hit && !apis.some((a) => a.api === hit.api)) apis.push({ api: hit.api, evidence: `imports ${imp}` });
        }
        if (imports.includes('dxgi.dll') && !apis.length) {
          apis.push({ api: 'DirectX 11/12', evidence: 'imports dxgi.dll (exact version not determinable from imports alone)' });
        }
        analysis.graphicsApi = apis;
      } catch (err) {
        analysis.errors.push(`Could not read executable metadata: ${err.message}`);
      }
    } else {
      analysis.ok = false;
      analysis.errors.push('No game executable found in the install folder. Add the executable manually in Advanced Mode.');
      analysis.targetDir = game.installDir;
    }

    const targetDir = analysis.targetDir;

    // 3. DLSS / Streamline / proxy files next to the executable
    let entries = [];
    try { entries = await fsp.readdir(targetDir); } catch { /* reported via errors below */ }
    if (!entries.length && analysis.ok) {
      analysis.errors.push(`Target folder is not readable: ${targetDir}`);
      analysis.ok = false;
    }

    for (const name of entries) {
      const lower = name.toLowerCase();
      const full = path.join(targetDir, name);
      let stat = null;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (!stat.isFile()) continue;

      const dlssRole = Object.entries(DLSS_FILES).find(([, names]) => names.includes(lower));
      const isStreamline = STREAMLINE_PLUGIN_PATTERN.test(name);
      if (!dlssRole && !isStreamline) continue;

      const info = {
        name,
        path: full,
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        sha256: await hashFile(full).catch(() => null),
        peVersion: null,
        detectedVersion: null,
        knownRuntimeVersion: null,
        knownInjection: null,
        is64bit: null,
      };
      if (lower.endsWith('.dll')) {
        const ver = await readFileVersion(full);
        if (ver && !ver.error) {
          info.peVersion = ver.fileVersion || ver.productVersion || null;
          info.is64bit = ver.headers ? ver.headers.is64bit : null;
          info.company = ver.companyName || null;
        }
      }
      if (info.sha256) {
        const rt = runtimeHashIndex.get(info.sha256.toLowerCase());
        if (rt) info.knownRuntimeVersion = rt.version;
        const inj = injectionHashIndex.get(info.sha256.toLowerCase());
        if (inj) info.knownInjection = inj;
      }
      info.detectedVersion = info.peVersion || info.knownRuntimeVersion || null;

      if (dlssRole) {
        analysis.dlss.files.push({ ...info, kind: dlssRole[0] });
      } else {
        analysis.streamline.files.push(info);
      }
    }

    analysis.dlss.detected = analysis.dlss.files.length > 0;
    const coreDlss = analysis.dlss.files.find((f) => f.kind === 'dlss') || analysis.dlss.files[0];
    analysis.dlss.primaryVersion = coreDlss ? coreDlss.detectedVersion : null;
    analysis.dlss.primaryFile = coreDlss ? coreDlss.name : null;
    analysis.dlss.versionSource = coreDlss
      ? coreDlss.peVersion ? 'PE version resource'
      : coreDlss.knownRuntimeVersion ? 'runtime library hash match'
      : 'unknown'
      : null;

    analysis.streamline.detected = analysis.streamline.files.length > 0;
    const slCommon = analysis.streamline.files.find((f) => f.name.toLowerCase() === 'sl.common.dll');
    analysis.streamline.version = (slCommon && slCommon.detectedVersion)
      || (analysis.streamline.files.find((f) => f.detectedVersion) || {}).detectedVersion
      || null;

    // 4. Injection / tooling status
    analysis.reshade = await detectReShade(targetDir);
    analysis.optiscaler = await detectOptiScaler(targetDir);
    analysis.marker = await this._readMarker(targetDir);
    if (analysis.marker) {
      const injOp = [...(analysis.marker.operations || [])].reverse().find((o) => o.type === 'injection-install');
      if (injOp) {
        analysis.injection = {
          installed: true,
          method: injOp.method || null,
          injectionName: injOp.injectionName || injOp.injectionId || null,
          injectionId: injOp.injectionId || null,
          installedAt: injOp.at || null,
          backupId: injOp.backupId || null,
          details: injOp,
        };
      }
      const rtOp = [...(analysis.marker.operations || [])].reverse().find((o) => o.type === 'runtime-install');
      if (rtOp) {
        analysis.installedRuntime = { version: rtOp.version, at: rtOp.at, backupId: rtOp.backupId };
      }
    }
    // Recognise injections by hash even without our marker (e.g. installed manually).
    if (!analysis.injection.installed) {
      for (const f of [...analysis.dlss.files, ...analysis.streamline.files]) {
        if (f.knownInjection) {
          analysis.injection = {
            installed: true,
            method: null,
            injectionName: f.knownInjection.injectionName,
            injectionId: f.knownInjection.injectionId,
            details: { recognizedBy: 'hash match', file: f.name },
          };
          break;
        }
      }
    }

    // 5. Graphics API fallback evidence (local engine dlls) when imports gave nothing
    if (!analysis.graphicsApi.length) {
      const localProxies = entries.filter((e) => PROXY_DLLS.includes(e.toLowerCase()));
      for (const p of localProxies) {
        const hit = API_IMPORT_MAP.find((m) => m.dll === p.toLowerCase());
        if (hit && !analysis.graphicsApi.some((a) => a.api === hit.api)) {
          analysis.graphicsApi.push({ api: hit.api, evidence: `local ${p} present (may belong to a mod — uncertain)` , uncertain: true });
        }
      }
      if (fs.existsSync(path.join(targetDir, 'MicrosoftGame.config'))) {
        analysis.graphicsApi.push({ api: 'DirectX 12', evidence: 'MicrosoftGame.config (Xbox/MS Store PC title)' });
      }
    }

    await this.logger.info(`Analyzed "${game.name}": DLSS ${analysis.dlss.detected ? analysis.dlss.primaryVersion || 'detected (version unknown)' : 'not detected'}, ` +
      `Streamline ${analysis.streamline.detected ? analysis.streamline.version || 'detected' : 'not detected'}, API: ${analysis.graphicsApi.map((a) => a.api).join(', ') || 'unknown'}`);
    return analysis;
  }

  /** Walk the install dir (bounded) collecting .exe candidates. */
  async _findExecutables(root) {
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > 3 || out.length > 64) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          try {
            const stat = await fsp.stat(path.join(dir, e.name));
            out.push({ path: path.join(dir, e.name), depth, size: stat.size });
          } catch { /* ignore */ }
        } else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) {
          await walk(path.join(dir, e.name), depth + 1);
        }
      }
    };
    await walk(root, 0);
    return out;
  }

  /** Score candidates and pick the primary executable. */
  _chooseExecutable(candidates, game) {
    if (!candidates.length) return null;
    const gameTokens = String(game.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const scored = candidates.map((c) => {
      const reasons = [];
      let score = 0;
      const name = path.basename(c.path);
      const stem = name.replace(/\.exe$/i, '').toLowerCase();

      if (game.exePath && path.resolve(game.exePath).toLowerCase() === path.resolve(c.path).toLowerCase()) {
        score += 1000; reasons.push('chosen by you / store metadata');
      }
      if (game.exeName && game.exeName.toLowerCase() === name.toLowerCase()) {
        score += 500; reasons.push('matches store metadata (LauncherExe)');
      }
      if (BAD_EXE_PATTERNS.test(name)) { score -= 80; reasons.push('name suggests a utility, not the game'); }
      if (c.depth === 0) { score += 10; reasons.push('located in install root'); }
      else if (c.depth <= 2) { score += 5; }
      else { score -= 5; }
      const dirName = path.basename(path.dirname(c.path)).toLowerCase();
      if (gameTokens.length && gameTokens.some((t) => stem.includes(t) || dirName.includes(t))) {
        score += 15; reasons.push('name matches the game title');
      }
      // Sibling DLSS/Streamline files strongly suggest the real game binary.
      const siblings = (() => {
        try { return fs.readdirSync(path.dirname(c.path)).map((s) => s.toLowerCase()); } catch { return []; }
      })();
      if (siblings.includes('nvngx_dlss.dll') || siblings.some((s) => /^sl\.[a-z0-9_]+\.dll$/.test(s))) {
        score += 25; reasons.push('DLSS/Streamline files present next to it');
      }
      score += Math.min(10, c.size / 50e6); // huge binaries are usually the game
      return { ...c, score, reasons };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  async _readMarker(targetDir) {
    try {
      const p = path.join(targetDir, APP.markerFileName);
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch {
      return null;
    }
  }
}

module.exports = { GameAnalyzer, API_IMPORT_MAP, BAD_EXE_PATTERNS };
