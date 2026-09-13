'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../hash');
const { readFileVersion } = require('../pe/peVersion');
const { PROXY_DLLS, APP } = require('../../shared/constants');
const { detectReShade } = require('../injection/reshade');
const { detectOptiScaler } = require('../injection/optiscaler');

/**
 * Conflict detection.
 *
 * Scans a game's target directory for graphics proxy DLLs and known modding
 * tool footprints, then classifies what will collide with a DLSS runtime
 * swap or a DLSS 5 injection install.
 *
 * Golden rule: we only WARN. Nothing is ever deleted or overwritten
 * automatically because of a conflict.
 */

const KNOWN_TOOLS = [
  { id: 'reshade', label: 'ReShade' },
  { id: 'optiscaler', label: 'OptiScaler' },
  { id: 'specialk', label: 'Special K', markers: ['specialk.ini', 'specialk'] },
  { id: 'dgvoodoo', label: 'dgVoodoo2', markers: ['dgvdoo2.conf', 'dgvoodoo.conf', 'dgvoodoocpl.exe'] },
  { id: 'dxvk', label: 'DXVK', markers: ['dxvk.conf', 'd3d9.dll.dxvk'] },
  { id: 'dlss-swapper-legacy', label: 'DLSS Swapper (legacy marker)', markers: ['.dlss_swapper_backup'] },
];

/**
 * @param {string} targetDir Folder containing the game executable.
 * @param {object} [opts]
 * @param {Map} [opts.runtimeHashIndex] sha256 → {version,name} from the runtime library.
 * @param {Map} [opts.injectionHashIndex] sha256 → {injectionId,file}.
 */
async function detectConflicts(targetDir, opts = {}) {
  const conflicts = [];
  if (!fs.existsSync(targetDir)) {
    return { targetDir, conflicts, summary: { blocking: 1 }, error: 'target folder does not exist' };
  }
  const entries = await fsp.readdir(targetDir).catch(() => []);
  const lowerEntries = entries.map((e) => e.toLowerCase());

  const reshade = await detectReShade(targetDir);
  const optiscaler = await detectOptiScaler(targetDir);

  // 1. Proxy DLLs present next to the executable.
  //    nvngx.dll is special: it is both a legitimate NVIDIA loader AND the
  //    most common OptiScaler proxy name, so it is always classified.
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lower.endsWith('.dll') || !(PROXY_DLLS.includes(lower) || lower === 'nvngx.dll')) continue;
    const full = path.join(targetDir, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    const sha256 = await hashFile(full).catch(() => null);
    const ver = lower.endsWith('.dll') ? await readFileVersion(full).catch(() => null) : null;

    // Who does this proxy most likely belong to?
    let owner = null;
    let ownerEvidence = null;
    if (optiscaler.proxyDll && path.resolve(optiscaler.proxyDll) === path.resolve(full)) {
      owner = 'optiscaler'; ownerEvidence = 'OptiScaler proxy (OptiScaler.ini / PE metadata)';
    } else if (reshade.proxyDll && path.resolve(reshade.proxyDll) === path.resolve(full)) {
      owner = 'reshade'; ownerEvidence = 'ReShade proxy (ReShade.ini present)';
    } else {
      for (const tool of KNOWN_TOOLS) {
        if (!tool.markers) continue;
        if (tool.markers.some((m) => lowerEntries.includes(m))) {
          owner = tool.id; ownerEvidence = `${tool.label} footprint: ${tool.markers.find((m) => lowerEntries.includes(m))}`;
          break;
        }
      }
    }

    const isOurs = sha256 && opts.injectionHashIndex && opts.injectionHashIndex.has(sha256.toLowerCase());
    const knownRuntime = sha256 && opts.runtimeHashIndex ? opts.runtimeHashIndex.get(sha256.toLowerCase()) : null;

    // Genuine NVIDIA nvngx.dll loader (not a proxy): informational only.
    if (lower === 'nvngx.dll' && !owner && ver && !ver.error && /nvidia/i.test(String(ver.companyName || ''))) {
      owner = 'nvidia';
      ownerEvidence = 'PE metadata reports NVIDIA Corporation';
    }

    const ownerLabel = isOurs
      ? 'DLSS Swapper 5 injection'
      : owner === 'nvidia'
        ? 'NVIDIA (original file)'
        : owner
          ? (KNOWN_TOOLS.find((t) => t.id === owner) || {}).label || owner
          : null;

    conflicts.push({
      type: 'proxy-dll',
      file: name,
      path: full,
      sizeBytes: stat.size,
      sha256,
      peVersion: ver && !ver.error ? ver.fileVersion || null : null,
      owner: isOurs ? 'dlss5-swapper-injection' : owner,
      ownerLabel,
      ownerEvidence: isOurs ? 'hash matches an imported injection package' : ownerEvidence,
      knownRuntimeVersion: knownRuntime ? knownRuntime.version : null,
      severity: isOurs || knownRuntime || owner === 'nvidia' ? 'info' : 'warning',
      message: isOurs
        ? `${name} belongs to a DLSS 5 injection previously installed through this app.`
        : knownRuntime
          ? `${name} matches runtime ${knownRuntime.version} from your library.`
          : owner === 'nvidia'
            ? `${name} is the genuine NVIDIA NVNGX loader (left untouched).`
            : owner
              ? `An existing graphics proxy DLL was found: ${name}. It appears to belong to ${ownerLabel}. This may conflict with the files this operation installs.`
              : `An existing graphics proxy DLL was found: ${name}. It may belong to another modification. Its origin could not be determined.`,
    });
  }

  // 2. Tool footprints without a proxy collision (informational).
  if (reshade.installed && !conflicts.some((c) => c.owner === 'reshade')) {
    conflicts.push({
      type: 'tool-footprint', owner: 'reshade', ownerLabel: 'ReShade', severity: 'info',
      message: `ReShade is installed here (${reshade.evidence.join('; ')}). The runtime swap does not touch ReShade files, but add-on based injections will interact with it.`,
    });
  }
  if (optiscaler.detected && !conflicts.some((c) => c.owner === 'optiscaler')) {
    conflicts.push({
      type: 'tool-footprint', owner: 'optiscaler', ownerLabel: 'OptiScaler', severity: 'info',
      message: `OptiScaler is installed here (${optiscaler.evidence.join('; ')}).`,
    });
  }

  // 3. Multiple DLSS runtimes in the tree (e.g. an old swapped DLL left in a subfolder).
  const strayDlss = [];
  for (const e of entries) {
    const st = await fsp.stat(path.join(targetDir, e)).catch(() => null);
    if (st && st.isDirectory()) {
      const sub = path.join(targetDir, e);
      const subEntries = await fsp.readdir(sub).catch(() => []);
      if (subEntries.some((s) => s.toLowerCase() === 'nvngx_dlss.dll')) strayDlss.push(path.join(sub, 'nvngx_dlss.dll'));
    }
  }
  for (const stray of strayDlss) {
    conflicts.push({
      type: 'stray-runtime', severity: 'info', path: stray, file: path.basename(stray),
      message: `A second nvngx_dlss.dll was found in a subfolder (${stray}). Some games load the DLL from a subdirectory; verify which copy the game actually uses.`,
    });
  }

  // 4. Our own marker (previous operations by this app).
  const markerPath = path.join(targetDir, APP.markerFileName);
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      const last = (marker.operations || [])[marker.operations.length - 1];
      conflicts.push({
        type: 'own-marker', owner: 'dlss5-swapper', severity: 'info',
        message: `This folder was modified by DLSS Swapper 5 before (${last ? last.type + ' @ ' + last.at : 'unknown operation'}). Existing backups can restore it.`,
        marker,
      });
    } catch { /* corrupt marker is itself worth flagging */
      conflicts.push({ type: 'own-marker', severity: 'warning', message: `${APP.markerFileName} exists but is unreadable.` });
    }
  }

  const blocking = conflicts.filter((c) => c.severity === 'blocking');
  const warnings = conflicts.filter((c) => c.severity === 'warning');
  return {
    targetDir,
    conflicts,
    summary: { total: conflicts.length, blocking: blocking.length, warnings: warnings.length },
    reshade,
    optiscaler,
  };
}

module.exports = { detectConflicts, KNOWN_TOOLS };
