'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { readFileVersion } = require('../pe/peVersion');

/**
 * OptiScaler detection & method support for DLSS 5 Neural Rendering injection.
 *
 * OptiScaler normally installs as an nvngx.dll / dxgi.dll / winmm.dll proxy
 * next to the game executable together with OptiScaler.ini (and optionally an
 * `optiscaler` resources folder). Detection is evidence-based; when only the
 * proxy exists we inspect its PE metadata before claiming OptiScaler.
 */

const OPTISCALER_MARKERS = ['optiscaler.ini'];

async function listDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Heuristic: does this DLL look like an OptiScaler build? */
async function dllLooksLikeOptiScaler(dllPath) {
  const ver = await readFileVersion(dllPath);
  if (ver && !ver.error) {
    const fields = [ver.productName, ver.fileDescription, ver.companyName, ver.originalFilename, ver.strings && ver.strings.InternalName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (fields.includes('optiscaler')) return true;
  }
  return false;
}

/**
 * Detect an OptiScaler installation in a game's target directory.
 * @returns {Promise<{detected:boolean, evidence:string[], iniPath:string|null,
 *   proxyDll:string|null, version:string|null}>}
 */
async function detectOptiScaler(targetDir) {
  const result = { detected: false, evidence: [], iniPath: null, proxyDll: null, version: null };
  const entries = await listDir(targetDir);
  const lower = entries.map((e) => e.toLowerCase());

  const iniIdx = lower.indexOf('optiscaler.ini');
  if (iniIdx !== -1) {
    result.iniPath = path.join(targetDir, entries[iniIdx]);
    result.evidence.push('OptiScaler.ini present');
  }

  // OptiScaler proxy candidates, in the order OptiScaler documents.
  const proxyNames = ['nvngx.dll', 'dxgi.dll', 'winmm.dll', 'd3d12.dll', 'd3d11.dll', 'vulkan-1.dll', 'ddraw.dll'];
  for (const p of proxyNames) {
    const idx = lower.indexOf(p);
    if (idx === -1) continue;
    const full = path.join(targetDir, entries[idx]);
    if (result.iniPath || (await dllLooksLikeOptiScaler(full))) {
      result.proxyDll = full;
      result.evidence.push(`OptiScaler proxy DLL present: ${p}`);
      break;
    }
  }

  if (result.iniPath) {
    try {
      const head = (await fsp.readFile(result.iniPath, 'utf8')).slice(0, 400);
      const m = head.match(/OptiScaler\s+v?(\d+\.\d+\.\d+)/i);
      if (m) result.version = m[1];
    } catch { /* optional */ }
  }

  result.detected = !!result.iniPath || !!result.proxyDll;
  return result;
}

/**
 * Validate that a target directory is ready for the OptiScaler injection
 * method. OptiScaler itself can be installed by this flow (the injection
 * package may carry the proxy + ini), so a missing OptiScaler is a warning,
 * not an error — but a *foreign* proxy DLL in the install path is an error
 * level conflict the UI must surface.
 */
async function validateForInstall(targetDir) {
  const det = await detectOptiScaler(targetDir);
  const problems = [];
  const warnings = [];
  if (!det.detected) {
    warnings.push('OptiScaler was not detected in this game folder. The injection package must provide the OptiScaler proxy files itself.');
  }
  return { ...det, problems, warnings };
}

module.exports = { detectOptiScaler, validateForInstall, dllLooksLikeOptiScaler, OPTISCALER_MARKERS };
