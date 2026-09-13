'use strict';

/**
 * Test helpers — build hermetic AppEnv instances in temp directories and
 * synthesize REAL fixture files (PE executables/DLLs with genuine version
 * resources and import tables) so tests exercise the actual code paths:
 * PE parsing, hashing, backup, install, verification and rollback.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { AppEnv } = require('../src/core/env');
const { createServices } = require('../src/core/app-services');
const { buildPeDll } = require('../src/core/pe/peBuilder');

/** Recording fake command runner. */
function fakeRunner(responses = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = cmd;
    if (typeof responses[key] === 'function') return responses[key](args, opts);
    if (responses[key]) return responses[key];
    return { stdout: '', stderr: '', code: 1 };
  };
  runner.calls = calls;
  return runner;
}

/** Create a temp data dir + services. Returns {env, services, dir, cleanup}. */
async function makeTestEnv(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dlss5-test-'));
  const env = new AppEnv({
    dataDir: path.join(dir, 'data'),
    resourcesDir: opts.resourcesDir || path.join(__dirname, '..', 'resources'),
    platform: opts.platform || 'linux',
    runner: opts.runner || fakeRunner(),
    homeDir: dir,
    env: opts.envVars || {},
  });
  await env.ensureDirs();
  const services = createServices({ env });
  const cleanup = async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return { env, services, dir, cleanup };
}

/** Build a synthetic runtime package (DLLs with correct PE versions) on disk. */
async function makeRuntimePackageFiles(services, version, { dir, corrupt = null } = {}) {
  const rt = await services.manifests.get(version);
  if (!rt) throw new Error(`unknown version ${version}`);
  const outDir = dir || (await fsp.mkdtemp(path.join(os.tmpdir(), `pkg-${version}-`)));
  const filePaths = [];
  for (const f of rt.files) {
    const p = path.join(outDir, f.name);
    if (/\.dll$/i.test(f.name)) {
      const ver = f.role === 'dlss-core'
        ? `${rt.dlssVersion || version}.0`
        : `${rt.streamlineVersion || version}.0`;
      let buf = buildPeDll({
        fileVersion: ver,
        productVersion: ver.replace(/\.0$/, ''),
        fileDescription: `Synthetic ${f.name} fixture for runtime ${version}`,
        productName: f.role === 'dlss-core' ? 'DLSS' : 'Streamline',
        companyName: 'DLSS Swapper 5 Test Tooling',
        originalFilename: f.name,
        imports: ['kernel32.dll'],
      });
      if (corrupt === f.name) {
        // Flip bytes in the middle so hash != any expected value but the file
        // still "exists" (tests corrupted-package detection).
        buf = Buffer.from(buf);
        buf[Math.floor(buf.length / 2)] ^= 0xff;
      }
      await fsp.writeFile(p, buf);
    } else {
      await fsp.writeFile(p, JSON.stringify({ fixture: f.name, runtime: version }, null, 2));
    }
    filePaths.push(p);
  }
  return { dir: outDir, filePaths };
}

/**
 * Build a fake game install.
 * @returns {Promise<{installDir:string, exePath:string, targetDir:string}>}
 */
async function makeFakeGame(services, opts = {}) {
  const {
    name = 'Aurora Protocol',
    exeName = 'aurora.exe',
    imports = ['kernel32.dll', 'd3d12.dll', 'dxgi.dll'],
    dlssVersion = '310.7.129',
    streamlineVersion = '2.12.129',
    withStreamline = true,
    withReShade = false,
    withOptiScaler = false,
    withDecoys = true,
    arch = 'x64',
    root = null,
  } = opts;
  const installDir = root || path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'game-')), name);
  await fsp.mkdir(installDir, { recursive: true });

  const exePath = path.join(installDir, exeName);
  await fsp.writeFile(exePath, buildPeDll({
    fileVersion: '1.0.0.0', fileDescription: `${name} (synthetic test executable)`,
    productName: name, originalFilename: exeName, imports, arch,
  }));

  if (withDecoys) {
    await fsp.writeFile(path.join(installDir, 'uninstall.exe'), buildPeDll({ fileVersion: '1.0.0.0', originalFilename: 'uninstall.exe' }));
    await fsp.writeFile(path.join(installDir, 'CrashReporter.exe'), buildPeDll({ fileVersion: '1.0.0.0', originalFilename: 'CrashReporter.exe' }));
  }

  if (dlssVersion) {
    await fsp.writeFile(path.join(installDir, 'nvngx_dlss.dll'), buildPeDll({
      fileVersion: `${dlssVersion}.0`, productVersion: dlssVersion,
      fileDescription: 'NVIDIA DLSS (synthetic fixture)', productName: 'DLSS',
      companyName: 'Test Tooling', originalFilename: 'nvngx_dlss.dll', arch,
    }));
  }
  if (withStreamline && streamlineVersion) {
    for (const n of ['sl.common.dll', 'sl.hooks.dll']) {
      await fsp.writeFile(path.join(installDir, n), buildPeDll({
        fileVersion: `${streamlineVersion}.0`, productVersion: streamlineVersion,
        fileDescription: `Streamline ${n} (synthetic fixture)`, productName: 'Streamline',
        originalFilename: n, arch,
      }));
    }
    await fsp.writeFile(path.join(installDir, 'sl.dlss.json'), JSON.stringify({ fixture: true }));
  }
  if (withReShade) {
    await fsp.writeFile(path.join(installDir, 'ReShade.ini'), '; ReShade fixture\n[GENERAL]\nEffectSearchPaths=.\\reshade-shaders\n');
    await fsp.mkdir(path.join(installDir, 'reshade-shaders', 'Shaders'), { recursive: true });
    await fsp.writeFile(path.join(installDir, 'reshade-shaders', 'Shaders', 'Fake.fx'), '// user shader — must never be touched\n');
    await fsp.writeFile(path.join(installDir, 'dxgi.dll'), buildPeDll({
      fileVersion: '6.1.0.0', fileDescription: 'ReShade (synthetic fixture)', productName: 'ReShade', originalFilename: 'dxgi.dll',
    }));
    await fsp.writeFile(path.join(installDir, 'MyPreset.ini'), '[GENERAL]\nTechniques=Fake@\n');
  }
  if (withOptiScaler) {
    await fsp.writeFile(path.join(installDir, 'OptiScaler.ini'), '; OptiScaler fixture\n[General]\n; user settings\nUpscaler=dldss\n');
    await fsp.writeFile(path.join(installDir, 'nvngx.dll'), buildPeDll({
      fileVersion: '0.6.0.0', fileDescription: 'OptiScaler proxy (synthetic fixture)', productName: 'OptiScaler', originalFilename: 'nvngx.dll',
    }));
  }

  return { installDir, exePath, targetDir: installDir };
}

/** Register a fake game in the store as a manual game. */
async function registerGame(services, { name, installDir, exePath }) {
  const id = await services.gameStore.addManual({ name, installDir, exePath });
  return services.gameStore.get(id);
}

/** Import a runtime package from fixture files. */
async function importRuntime(services, version, opts = {}) {
  const { filePaths } = await makeRuntimePackageFiles(services, version, opts);
  const res = await services.runtimeLibrary.importPackage({ version, filePaths, origin: 'test' });
  return res;
}

module.exports = {
  fakeRunner,
  makeTestEnv,
  makeRuntimePackageFiles,
  makeFakeGame,
  registerGame,
  importRuntime,
};
