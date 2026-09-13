'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { PROXY_DLLS } = require('../../shared/constants');

/**
 * ReShade detection & method support for DLSS 5 Neural Rendering injection.
 *
 * ReShade installs a proxy graphics DLL (dxgi.dll / d3d11.dll / d3d9.dll /
 * opengl32.dll / dinput8.dll / winmm.dll ...) next to the game executable,
 * plus ReShade.ini and typically a reshade-shaders folder. Add-ons are
 * *.addon64 / *.addon32 files discovered via AddonSearchPaths in ReShade.ini.
 *
 * Detection is evidence-based: marker files first, proxy DLLs second.
 */

const RESHADE_MARKERS = ['reshade.ini', 'reshade.log', 'reshade-shaders', 'reshade-presets', 'effectsearchpaths'];

async function listDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Detect a ReShade installation in a game's target directory.
 * @returns {Promise<{installed:boolean, evidence:string[], proxyDll:string|null,
 *   iniPath:string|null, shadersDir:string|null, addons:string[], presetFiles:string[]}>}
 */
async function detectReShade(targetDir) {
  const result = {
    installed: false,
    evidence: [],
    proxyDll: null,
    iniPath: null,
    shadersDir: null,
    addons: [],
    presetFiles: [],
    version: null,
  };
  const entries = await listDir(targetDir);
  const lower = entries.map((e) => e.toLowerCase());

  const iniIdx = lower.indexOf('reshade.ini');
  if (iniIdx !== -1) {
    result.iniPath = path.join(targetDir, entries[iniIdx]);
    result.evidence.push('ReShade.ini present');
  }
  const shadersIdx = lower.findIndex((e) => e === 'reshade-shaders');
  if (shadersIdx !== -1) {
    result.shadersDir = path.join(targetDir, entries[shadersIdx]);
    result.evidence.push('reshade-shaders folder present');
  }
  if (lower.includes('reshade.log')) result.evidence.push('ReShade.log present');

  // Proxy DLL: ReShade renames itself to a system DLL name. Without the ini we
  // cannot be sure which proxy belongs to ReShade vs another tool, so only
  // count proxies as ReShade evidence when a marker exists.
  const proxies = entries.filter((e) => PROXY_DLLS.includes(e.toLowerCase()) && e.toLowerCase().endsWith('.dll'));
  if (result.iniPath && proxies.length) {
    // Prefer the most common ReShade proxies in order.
    const preference = ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d9.dll', 'opengl32.dll', 'winmm.dll', 'version.dll', 'ddraw.dll', 'd3d8.dll', 'vulkan-1.dll'];
    for (const p of preference) {
      if (proxies.some((x) => x.toLowerCase() === p)) {
        result.proxyDll = path.join(targetDir, proxies.find((x) => x.toLowerCase() === p));
        result.evidence.push(`Proxy DLL present: ${p}`);
        break;
      }
    }
  }

  // Installed add-ons and presets (we must never overwrite these).
  for (const e of entries) {
    if (/\.addon(64|32)$/i.test(e)) result.addons.push(e);
    if (/\.ini$/i.test(e) && e.toLowerCase() !== 'reshade.ini') result.presetFiles.push(e);
  }

  result.installed = !!result.iniPath || (!!result.proxyDll && lower.some((e) => RESHADE_MARKERS.includes(e)));
  if (result.iniPath) {
    // Best-effort version read from the ini header comment if present.
    try {
      const head = (await fsp.readFile(result.iniPath, 'utf8')).slice(0, 400);
      const m = head.match(/ReShade\s+(\d+\.\d+\.\d+)/i);
      if (m) result.version = m[1];
    } catch { /* optional */ }
  }
  return result;
}

/**
 * Validate that a target directory is ready for the ReShade injection method.
 * Returns problems[] (empty = ready).
 */
async function validateForInstall(targetDir) {
  const det = await detectReShade(targetDir);
  const problems = [];
  if (!det.installed) {
    problems.push('ReShade is not installed in this game folder. Install ReShade (with add-on support) for the game first, then run this installer.');
  }
  if (det.installed && !det.proxyDll) {
    problems.push('ReShade configuration found, but no proxy graphics DLL could be identified next to the executable. ReShade may be installed in a different folder.');
  }
  return { ...det, problems };
}

module.exports = { detectReShade, validateForInstall, RESHADE_MARKERS };
void fs;
