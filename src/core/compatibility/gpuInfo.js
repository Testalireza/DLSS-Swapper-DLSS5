'use strict';

const { NVIDIA_ARCHITECTURES, MIN_DLSS_COMPUTE_CAPABILITY } = require('../../shared/constants');
const { compareVersions } = require('../../shared/format');

/**
 * GPU information & RTX compatibility.
 *
 * Detection order (most reliable first):
 *   1. nvidia-smi CSV query — name, driver, VRAM, CUDA compute capability
 *   2. WMI Win32_VideoController via PowerShell — name, driver, approx VRAM, PNP id
 *   3. Nothing → compatibility "unknown" (UI shows the ⚠ could-not-verify state;
 *      Advanced Mode can override).
 *
 * Compatibility is decided from the compute capability when available
 * (≥ 7.5 ⇒ Turing-or-newer with Tensor Cores), cross-checked against the
 * product name series. Name-only guesses are flagged as lower confidence.
 */

/** Minimum driver branch for the DLSS 5 neural rendering workflow. */
const MIN_DRIVER_VERSION = '580.00';

class GpuService {
  /**
   * @param {import('../env').AppEnv} env
   * @param {import('../logger').Logger} logger
   * @param {import('../settings').SettingsService} settings
   */
  constructor(env, logger, settings) {
    this.env = env;
    this.logger = logger;
    this.settings = settings;
    this._cache = null;
    this._cachedAt = 0;
  }

  /**
   * @param {boolean} [refresh] Bypass the 60s cache.
   */
  async getInfo(refresh = false) {
    if (!refresh && this._cache && Date.now() - this._cachedAt < 60000) return this._cache;

    const gpus = [];
    const detectedVia = [];

    // ---- nvidia-smi (authoritative for NVIDIA) ----
    try {
      const { stdout, code } = await this.env.runner('nvidia-smi', [
        '--query-gpu=name,driver_version,memory.total,compute_cap',
        '--format=csv,noheader,nounits',
      ], { timeout: 8000 });
      if (code === 0 && stdout.trim()) {
        detectedVia.push('nvidia-smi');
        for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const [name, driver, memMib, cc] = line.split(',').map((s) => s.trim());
          if (!name) continue;
          gpus.push({
            name,
            vendor: 'NVIDIA',
            driverVersion: driver || null,
            vramBytes: memMib && Number.isFinite(Number(memMib)) ? Math.round(Number(memMib) * 1024 * 1024) : null,
            computeCapability: cc && Number.isFinite(Number(cc)) ? Number(cc) : null,
            pnpId: null,
          });
        }
      }
    } catch { /* not installed / not NVIDIA */ }

    // ---- WMI fallback / supplement (Windows) ----
    if (this.env.isWindows && (!gpus.length || !detectedVia.includes('nvidia-smi'))) {
      try {
        const ps = [
          'Get-CimInstance Win32_VideoController |',
          'Select-Object Name,DriverVersion,AdapterRAM,PNPDeviceID,VideoProcessor |',
          'ConvertTo-Json -Compress',
        ].join(' ');
        const { stdout } = await this.env.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
        const text = stdout.trim();
        if (text) {
          detectedVia.push('wmi');
          const rows = text.startsWith('[') ? JSON.parse(text) : [JSON.parse(text)];
          for (const r of rows) {
            if (!r || !r.Name) continue;
            const vendor = /nvidia/i.test(r.Name) ? 'NVIDIA' : /amd|radeon/i.test(r.Name) ? 'AMD' : /intel|arc/i.test(r.Name) ? 'Intel' : 'Unknown';
            const known = gpus.find((g) => g.name.toLowerCase() === String(r.Name).toLowerCase());
            if (known) {
              known.pnpId = r.PNPDeviceID || known.pnpId;
              if (!known.driverVersion) known.driverVersion = r.DriverVersion || null;
              continue;
            }
            gpus.push({
              name: r.Name,
              vendor,
              driverVersion: r.DriverVersion || null,
              // AdapterRAM is 32-bit in WMI — >4GB reports wrap; treat as approximate.
              vramBytes: Number.isFinite(r.AdapterRAM) ? r.AdapterRAM : null,
              vramApproximate: true,
              computeCapability: null,
              pnpId: r.PNPDeviceID || null,
              videoProcessor: r.VideoProcessor || null,
            });
          }
        }
      } catch (err) {
        await this.logger.debug(`WMI GPU query failed: ${err.message}`);
      }
    }

    // ---- classify each GPU ----
    for (const gpu of gpus) {
      const cls = GpuService.classify(gpu.name, gpu.computeCapability);
      Object.assign(gpu, cls);
    }

    const nvidia = gpus.find((g) => g.vendor === 'NVIDIA') || null;
    const settings = this.settings ? await this.settings.get().catch(() => ({})) : {};
    const compatibility = GpuService.assessCompatibility(nvidia, gpus, {
      detectedVia,
      override: !!settings.gpuCompatibilityOverride,
      minDriver: MIN_DRIVER_VERSION,
    });

    const info = {
      gpus,
      nvidia,
      compatibility,
      detectedVia,
      minDriverVersion: MIN_DRIVER_VERSION,
      minComputeCapability: MIN_DLSS_COMPUTE_CAPABILITY,
      checkedAt: new Date().toISOString(),
    };
    this._cache = info;
    this._cachedAt = Date.now();
    await this.logger.info(`GPU check: ${gpus.map((g) => g.name).join(', ') || 'none detected'} → ${compatibility.status}`);
    return info;
  }

  /**
   * Map a GPU name + optional compute capability to architecture/series.
   * Compute capability wins when present (spec: don't rely on names alone).
   */
  static classify(name, computeCapability) {
    const n = String(name || '');
    let architecture = null;
    let series = null;
    let confidence = 'low';
    let isRtx = false;

    if (Number.isFinite(computeCapability)) {
      confidence = 'high';
      if (computeCapability >= 12.0) architecture = 'Blackwell';
      else if (computeCapability >= 8.9) architecture = 'Ada Lovelace';
      else if (computeCapability >= 8.0) architecture = 'Ampere';
      else if (computeCapability >= 7.5) architecture = 'Turing';
      else if (computeCapability >= 6.0) architecture = 'Pascal';
      else architecture = 'Maxwell or older';
    }

    const rtx = n.match(/RTX\s*(\d{2})\d{2}/i);
    const gtx = n.match(/GTX\s*(\d{3,4})/i);
    if (rtx) {
      isRtx = true;
      const gen = Number(rtx[1]);
      series = `RTX ${gen} series`;
      if (!architecture) {
        confidence = 'medium';
        architecture = gen >= 50 ? 'Blackwell' : gen >= 40 ? 'Ada Lovelace' : gen >= 30 ? 'Ampere' : 'Turing';
      }
    } else if (/RTX\s*[A-Z]?\d{3,4}/i.test(n)) {
      // RTX A6000 / RTX 6000 Ada style professional cards
      isRtx = true;
      series = 'RTX professional';
      if (!architecture) { confidence = 'medium'; architecture = /ada/i.test(n) ? 'Ada Lovelace' : 'Ampere'; }
    } else if (/TITAN RTX/i.test(n)) {
      isRtx = true;
      series = 'RTX (TITAN)';
      if (!architecture) { confidence = 'medium'; architecture = 'Turing'; }
    } else if (gtx) {
      series = /^16/.test(gtx[1]) ? 'GTX 16 series' : 'GTX series';
      if (!architecture) { confidence = 'medium'; architecture = /^16/.test(gtx[1]) ? 'Turing' : 'Pascal or older'; }
    }

    const archEntry = NVIDIA_ARCHITECTURES.find((a) => architecture && a.name === architecture);
    return {
      architecture,
      series,
      isRtx,
      dlssCapable: Number.isFinite(computeCapability)
        ? computeCapability >= MIN_DLSS_COMPUTE_CAPABILITY
        : isRtx,
      confidence,
      archEntry: archEntry || null,
    };
  }

  /**
   * Overall compatibility verdict for the DLSS 5 Neural Rendering workflow.
   * @returns {{status:'supported'|'unsupported'|'unknown', reasons:string[], warnings:string[], ...}}
   */
  static assessCompatibility(nvidia, allGpus, { detectedVia, override, minDriver }) {
    const reasons = [];
    const warnings = [];

    if (!allGpus.length || !detectedVia.length) {
      return {
        status: 'unknown',
        headline: 'Compatibility could not be fully verified.',
        reasons: ['No GPU information could be retrieved (nvidia-smi and WMI both unavailable).'],
        warnings,
        overridden: !!override,
        canOverride: true,
      };
    }

    if (!nvidia) {
      return {
        status: 'unsupported',
        headline: 'No NVIDIA GPU detected.',
        reasons: [`Detected GPU(s): ${allGpus.map((g) => g.name).join(', ')}. DLSS and DLSS 5 Neural Rendering require an NVIDIA RTX graphics card.`],
        warnings,
        overridden: !!override,
        canOverride: true,
      };
    }

    if (nvidia.computeCapability != null) {
      if (nvidia.computeCapability >= MIN_DLSS_COMPUTE_CAPABILITY) {
        reasons.push(`CUDA compute capability ${nvidia.computeCapability} ≥ ${MIN_DLSS_COMPUTE_CAPABILITY} (Tensor Cores present).`);
      } else {
        return {
          status: 'unsupported',
          headline: `${nvidia.name} is not DLSS capable.`,
          reasons: [`CUDA compute capability ${nvidia.computeCapability} < ${MIN_DLSS_COMPUTE_CAPABILITY}. DLSS requires Turing (RTX 20 series) or newer with Tensor Cores.`],
          warnings,
          overridden: !!override,
          canOverride: true,
        };
      }
    } else if (nvidia.isRtx) {
      reasons.push(`Product name indicates ${nvidia.series || 'an RTX GPU'} (name-based confidence only).`);
      warnings.push('Compute capability could not be read — compatibility is based on the GPU name alone.');
    } else {
      return {
        status: 'unknown',
        headline: 'Compatibility could not be fully verified.',
        reasons: [`${nvidia.name} detected, but neither compute capability nor an RTX product name could confirm Tensor Core support.`],
        warnings,
        overridden: !!override,
        canOverride: true,
      };
    }

    if (nvidia.architecture && !/RTX/.test(nvidia.series || '') && nvidia.computeCapability == null) {
      warnings.push(`${nvidia.name}: architecture ${nvidia.architecture} inferred without compute capability.`);
    }

    // Driver check
    if (nvidia.driverVersion) {
      // NVIDIA drivers look like "580.65" (smi) or "32.0.15.8065" (WMI); normalise.
      const normalized = GpuService.normalizeDriver(nvidia.driverVersion);
      if (normalized && compareVersions(normalized, minDriver) < 0) {
        warnings.push(`Driver ${nvidia.driverVersion} is older than the recommended ${minDriver} branch for DLSS 5 workflows. Update your NVIDIA driver for best results.`);
      } else if (normalized) {
        reasons.push(`Driver ${nvidia.driverVersion} meets the recommended ${minDriver}+ branch.`);
      }
    } else {
      warnings.push('Driver version could not be determined.');
    }

    return {
      status: 'supported',
      headline: `${nvidia.name} — supported (${nvidia.series || nvidia.architecture || 'NVIDIA RTX'}).`,
      reasons,
      warnings,
      overridden: false,
      canOverride: false,
    };
  }

  /**
   * WMI reports NVIDIA drivers as e.g. 32.0.15.8065 — the last five digits of
   * the final two groups encode the real driver version (580.65).
   */
  static normalizeDriver(v) {
    const s = String(v || '');
    const parts = s.split('.');
    if (parts.length === 4) {
      const tail = parts[2] + parts[3];
      if (tail.length >= 5) {
        const last5 = tail.slice(-5);
        return `${last5.slice(0, 3)}.${last5.slice(3)}`;
      }
    }
    if (/^\d+(\.\d+)+$/.test(s)) return s;
    return null;
  }
}

module.exports = { GpuService, MIN_DRIVER_VERSION };
