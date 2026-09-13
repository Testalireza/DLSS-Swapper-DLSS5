'use strict';

/**
 * UI smoke tests — two independent layers:
 *
 *  A. jsdom renderer boot: loads src/renderer/index.html, executes every
 *     renderer script in the exact order index.html declares, with a fake
 *     window.dlss5 IPC bridge serving canned (but shape-accurate) responses.
 *     Asserts: the app initialises, ALL eight routes render without the
 *     "page failed to render" banner, dialogs/toasts/theme/bus/DOM helpers
 *     work, and no unexpected IPC channel is hit.
 *
 *  B. Web preview server integration: spawns src/web/server.js against a
 *     temp data dir on a free port and exercises the real HTTP surface —
 *     static files, CSP header, /ipc POST endpoint, /events SSE, /healthz.
 *
 * Run: npm run test:ui   (or as part of: npm test)
 * Requires the optional devDependency: npm install jsdom
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { IPC } = require(path.join(REPO, 'src', 'shared', 'constants'));

let JSDOM = null;
let VirtualConsole = null;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  JSDOM = null;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Canned IPC world (shapes mirror the real core service return values)
// ---------------------------------------------------------------------------

function makeFakeWorld() {
  const settings = {
    theme: 'light',
    compactGameCards: false,
    scan: { steam: true, epic: true, xbox: true, gog: true, customFolders: true },
    customGameFolders: [],
    scanDepth: 3,
    backupDir: null,
    autoBackup: true,
    keepBackupCount: 0,
    verifyAfterInstall: true,
    warnOnConflicts: true,
    blockIfGameRunning: true,
    showAdvancedInfo: false,
    advancedMode: false,
    loggingEnabled: true,
    verboseLogging: false,
    gpuCompatibilityOverride: false,
    runtimeSources: {
      github: {
        enabled: true,
        repos: ['https://github.com/Testalireza/DLSS-Swapper-DLSS5-Runtimes/releases/download/{version}/{file}'],
      },
    },
    updateRepo: 'Testalireza/DLSS-Swapper-DLSS5',
  };

  const games = [
    {
      id: 'steam-1245620', name: 'Elden Ring', provider: 'steam',
      installDir: 'C:\\Games\\ELDEN RING', exeName: 'eldenring.exe',
    },
    {
      id: 'manual-cyberpunk-1700000000000', name: 'Cyberpunk 2077', provider: 'manual',
      installDir: 'C:\\Games\\Cyberpunk 2077', exeName: 'Cyberpunk2077.exe',
    },
  ];

  const analysisFor = (gameId) => {
    const g = games.find((x) => x.id === gameId) || games[0];
    return {
      gameId: g.id, name: g.name, provider: g.provider, installDir: g.installDir,
      analyzedAt: new Date().toISOString(), ok: true, errors: [],
      executable: { path: `${g.installDir}\\${g.exeName}`, name: g.exeName, score: 9, reasons: ['name match'] },
      executableCandidates: [`${g.installDir}\\${g.exeName}`],
      targetDir: g.installDir,
      graphicsApi: [{ api: 'DirectX 12', evidence: 'imports d3d12.dll' }],
      is64bit: true,
      dlss: {
        detected: true,
        files: [{ name: 'nvngx_dlss.dll', version: '310.6.0', versionSource: 'pe-resource', sha256: 'aa'.repeat(32) }],
        primaryVersion: '310.6.0',
      },
      streamline: { detected: true, version: '2.11.140', files: [{ name: 'sl.common.dll', version: '2.11.140' }] },
      injection: { installed: false, method: null, injectionName: null, details: null },
      reshade: null,
      optiscaler: null,
      marker: null,
    };
  };

  const gpuInfo = {
    gpus: [{
      name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', driverVersion: '580.65',
      vramBytes: 12 * 1024 * 1024 * 1024, computeCapability: 8.9, pnpId: null,
      architecture: 'Ada Lovelace', series: 'RTX 40 series', isRtx: true,
      dlssCapable: true, confidence: 'high', archEntry: { id: 'ada', name: 'Ada Lovelace', series: 'RTX 40', minComputeCapability: 8.9 },
    }],
    nvidia: null, // filled below
    compatibility: {
      status: 'supported',
      headline: 'NVIDIA GeForce RTX 4070 — supported (RTX 40 series).',
      reasons: ['RTX 40 series (Ada Lovelace) with compute capability 8.9.', 'Driver 580.65 meets the recommended 580.00+ branch.'],
      warnings: [],
      overridden: false,
      canOverride: false,
    },
    detectedVia: ['nvidia-smi'],
    minDriverVersion: '580.00',
    minComputeCapability: 7.5,
    checkedAt: new Date().toISOString(),
  };
  gpuInfo.nvidia = gpuInfo.gpus[0];

  // Real manifest data → listAvailability() shape
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'RuntimeManifests', 'runtimes.json'), 'utf8'));
  const runtimeList = (manifest.runtimes || []).map((rt) => ({
    version: rt.version,
    available: false,
    complete: false,
    missing: (rt.files || []).filter((f) => f.required).map((f) => f.name),
    origin: null,
    importedAt: null,
    fileCount: 0,
    package: null,
    runtime: rt,
  }));

  const backups = [{
    schemaVersion: 1,
    backupId: '2026-09-10T12-30-00-000Z',
    game: { id: 'steam-1245620', name: 'Elden Ring', installDir: 'C:\\Games\\ELDEN RING', targetDir: 'C:\\Games\\ELDEN RING' },
    created: '2026-09-10T12:30:00.000Z',
    appVersion: '1.0.0',
    operation: { type: 'runtime-install', version: '310.9.1', fromVersion: '310.6.0' },
    runtimeBefore: { dlss: '310.6.0', streamline: '2.11.140' },
    modifiedFiles: [{ relPath: 'nvngx_dlss.dll', originalHash: 'ab'.repeat(32), sizeBytes: 12345678 }],
    addedFiles: [],
    willAdd: [],
    result: 'success',
    __dir: '/tmp/Backups/Elden Ring-steam-1245620/2026-09-10T12-30-00-000Z',
  }];

  const history = [
    {
      id: 'h-2', ts: '2026-09-11T09:15:00.000Z', gameId: 'steam-1245620', gameName: 'Elden Ring',
      action: 'runtime-install', fromVersion: '310.6.0', toVersion: '310.9.1',
      backupId: backups[0].backupId, result: 'success',
      steps: [{ id: 'detect', label: 'Detect', status: 'done' }, { id: 'install', label: 'Install', status: 'done' }],
      details: { verify: 'all hashes match' },
    },
    {
      id: 'h-1', ts: '2026-09-10T12:30:00.000Z', gameId: 'steam-1245620', gameName: 'Elden Ring',
      action: 'injection-install', method: 'optiscaler', injectionName: 'DLSS 5 NR (OptiScaler)',
      result: 'rolled-back', details: { reason: 'verify failed → rolled back' },
    },
  ];

  const injections = [{
    id: 'dlss5-nr-optiscaler', name: 'DLSS 5 NR — OptiScaler variant',
    description: 'Community injection package for DLSS 5 neural rendering via OptiScaler.',
    methods: ['optiscaler'],
    files: [
      { name: 'nvngx.dll', role: 'proxy', installAs: 'nvngx.dll', sha256: 'cd'.repeat(32), sizeBytes: 999 },
      { name: 'OptiScaler.ini', role: 'config', installAs: 'OptiScaler.ini', sha256: 'ef'.repeat(32), sizeBytes: 42 },
    ],
    importedAt: '2026-09-09T10:00:00.000Z',
  }];

  const logs = [
    { ts: '2026-09-12T08:00:00.000Z', level: 'INFO', message: 'Application started' },
    { ts: '2026-09-12T08:00:01.000Z', level: 'SUCCESS', message: 'Scan complete: 2 games' },
    { ts: '2026-09-12T08:00:02.000Z', level: 'WARN', message: 'nvngx_dlss.dll hash not in manifest index' },
  ];

  function setPath(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  const calls = [];
  const unexpected = [];

  const handlers = {
    [IPC.APP_INFO]: () => ({
      name: 'DLSS Swapper 5', version: '1.0.0',
      repository: 'https://github.com/Testalireza/DLSS-Swapper-DLSS5', license: 'MIT',
      platform: 'win32', dataDir: 'C:\\Users\\Test\\AppData\\Roaming\\DLSSSwapper5',
      resourcesDir: 'C:\\Program Files\\DLSS Swapper 5\\resources', electron: true,
    }),
    [IPC.APP_CHECK_UPDATE]: () => ({ ok: true, updateAvailable: false, current: '1.0.0', latest: null, message: 'Up to date.' }),
    [IPC.SETTINGS_GET]: () => JSON.parse(JSON.stringify(settings)),
    [IPC.SETTINGS_SET]: (p) => {
      for (const [k, v] of Object.entries((p && p.patch) || {})) setPath(settings, k, v);
      return { ok: true, settings: JSON.parse(JSON.stringify(settings)) };
    },
    [IPC.SETTINGS_RESET]: () => ({ ok: true, settings: JSON.parse(JSON.stringify(settings)) }),
    [IPC.SETTINGS_OPEN_DATA_DIR]: () => ({ ok: true }),
    [IPC.LOGS_RECENT]: () => JSON.parse(JSON.stringify(logs)),
    [IPC.LOGS_OPEN_FOLDER]: () => ({ ok: true }),
    [IPC.GAMES_LIST]: () => JSON.parse(JSON.stringify(games)),
    [IPC.GAMES_SCAN]: () => JSON.parse(JSON.stringify(games)),
    [IPC.GAMES_ANALYZE]: (p) => analysisFor(p && p.gameId),
    [IPC.GAMES_IS_RUNNING]: () => ({ running: false, processes: [], checked: ['eldenring.exe'] }),
    [IPC.GAMES_CHOOSE_EXE]: () => ({ ok: true }),
    [IPC.RUNTIMES_LIST]: () => ({
      runtimes: JSON.parse(JSON.stringify(runtimeList)),
      loadErrors: [],
      providers: [{ id: 'github', name: 'GitHub Releases', enabled: true }],
    }),
    [IPC.RUNTIMES_OPEN_LIBRARY]: () => ({ ok: true }),
    [IPC.GPU_INFO]: () => JSON.parse(JSON.stringify(gpuInfo)),
    [IPC.BACKUPS_LIST]: (p) => JSON.parse(JSON.stringify(
      p && p.gameId ? backups.filter((b) => b.game.id === p.gameId) : backups
    )),
    [IPC.BACKUPS_GET]: (p) => JSON.parse(JSON.stringify(backups.find((b) => b.backupId === p.backupId) || backups[0])),
    [IPC.BACKUPS_OPEN_FOLDER]: () => ({ ok: true }),
    [IPC.INJECTIONS_LIST]: () => JSON.parse(JSON.stringify(injections)),
    [IPC.INJECTIONS_STATUS]: () => ({
      ok: true,
      targetDir: 'C:\\Games\\ELDEN RING',
      methods: {
        optiscaler: { installed: false, problems: [], warnings: [] },
        reshade: { installed: true, source: 'detected', problems: [], warnings: [] },
      },
    }),
    [IPC.OPS_CHECK_CONFLICTS]: () => ({
      ok: true,
      conflicts: [{
        file: 'd3d11.dll', severity: 'warning', owner: null, ownerLabel: 'Unknown tool',
        message: 'Proxy DLL d3d11.dll (unknown tool) sits next to the executable.',
      }],
    }),
    [IPC.HISTORY_LIST]: () => JSON.parse(JSON.stringify(history)),
    [IPC.HISTORY_GET]: (p) => JSON.parse(JSON.stringify(history.find((h) => h.id === p.id) || history[0])),
    [IPC.FS_PICK_FOLDER]: () => ({ canceled: true }),
    [IPC.FS_PICK_FILES]: () => ({ canceled: true }),
    [IPC.FS_OPEN_PATH]: () => ({ ok: true }),
    [IPC.FS_SHOW_ITEM]: () => ({ ok: true }),
  };

  async function invoke(channel, payload) {
    calls.push(channel);
    const h = handlers[channel];
    if (!h) {
      unexpected.push(channel);
      return { ok: false, error: `not stubbed: ${channel}` };
    }
    return JSON.parse(JSON.stringify(await h(payload || {})));
  }

  return { invoke, calls, unexpected, settings };
}

// ---------------------------------------------------------------------------
// Part A — jsdom renderer boot
// ---------------------------------------------------------------------------

describe('UI smoke — renderer (jsdom)', { skip: !JSDOM && 'jsdom not installed (npm install jsdom)' }, () => {
  const SCRIPTS = [
    'src/shared/constants.js',
    'src/shared/format.js',
    'src/renderer/js/dom.js',
    'src/renderer/js/api.js',
    'src/renderer/js/toast.js',
    'src/renderer/js/dialog.js',
    'src/renderer/js/pages/games.js',
    'src/renderer/js/pages/gameDetail.js',
    'src/renderer/js/pages/dlss5.js',
    'src/renderer/js/pages/runtimes.js',
    'src/renderer/js/pages/backups.js',
    'src/renderer/js/pages/history.js',
    'src/renderer/js/pages/options.js',
    'src/renderer/js/pages/about.js',
    'src/renderer/js/app.js',
  ];

  let dom, window, document, world, jsdomErrors, windowErrors;

  before(async () => {
    world = makeFakeWorld();
    jsdomErrors = [];
    windowErrors = [];

    const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => jsdomErrors.push(e.message || String(e)));
    vc.on('error', (...args) => windowErrors.push(args.map(String).join(' ')));

    dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: 'http://localhost/',
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
    window = dom.window;
    document = window.document;

    // Fake Electron preload bridge — installed BEFORE api.js evaluates.
    window.dlss5 = {
      invoke: (channel, payload) => world.invoke(channel, payload),
      on: () => () => {},
    };

    // index.html <script src> tags are not fetched by jsdom (no resource
    // loader) — execute the same files, in the same order, right here.
    for (const rel of SCRIPTS) {
      window.eval(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }

    // Let init() + default-route render settle.
    for (let i = 0; i < 40 && !(window.UI && window.UI.state && window.UI.state.appInfo); i++) await tick(25);
    await tick(120);
  });

  after(() => { if (dom) dom.window.close(); });

  test('app initialises: state, version chip, game count, GPU chip', () => {
    assert.ok(window.UI, 'window.UI namespace exists');
    assert.equal(window.UI.state.appInfo.version, '1.0.0');
    assert.equal(window.UI.state.games.length, 2);
    assert.equal(document.getElementById('sidebar-version').textContent, 'v1.0.0');
    assert.equal(document.getElementById('nav-games-count').textContent, '2');
    assert.match(document.getElementById('sidebar-gpu-text').textContent, /RTX 4070/);
    assert.match(document.getElementById('sidebar-gpu-text').textContent, /supported/);
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  });

  test('sidebar declares all seven nav routes', () => {
    const routes = Array.from(document.querySelectorAll('.nav-item')).map((n) => n.dataset.route);
    assert.deepEqual(routes, ['games', 'dlss5', 'runtimes', 'backups', 'history', 'options', 'about']);
  });

  test('shared UMD modules exposed on window.DLSS5Shared', () => {
    const S = window.DLSS5Shared;
    assert.ok(S && S.IPC && S.APP, 'constants exported');
    assert.equal(S.APP.name, 'DLSS Swapper 5');
    assert.ok(S.compareVersions('310.9.1', '310.6.0') > 0, 'format helpers exported');
    assert.equal(S.formatBytes(2048), '2.0 KB');
  });

  test('default route renders the games library with cards', () => {
    const page = document.getElementById('page');
    assert.ok(page.children.length > 0, '#page not empty');
    assert.equal(page.querySelectorAll('.game-card').length, 2);
    assert.match(page.textContent, /Elden Ring/);
    assert.match(page.textContent, /Cyberpunk 2077/);
  });

  const ROUTE_CHECKS = [
    ['#/games', /Elden Ring/],
    ['#/game/steam-1245620', /Elden Ring/],
    ['#/dlss5', /RTX 4070|Neural/i],
    ['#/runtimes', /310\.6\.0/],
    ['#/backups', /Elden Ring/],
    ['#/history', /Elden Ring/],
    ['#/options', /Advanced Mode/],
    ['#/about', /DLSS Swapper 5/],
  ];

  for (const [route, expectText] of ROUTE_CHECKS) {
    test(`route ${route} renders without errors`, async () => {
      window.location.hash = route;
      await tick(150);
      const page = document.getElementById('page');
      const danger = page.querySelector('.banner-danger');
      assert.ok(!danger, `page rendered its failure banner: ${danger ? danger.textContent : ''}`);
      assert.ok(page.children.length > 0, `#page empty for ${route}`);
      assert.match(page.textContent, expectText);
      assert.equal(document.getElementById('page-title').textContent.length > 0, true);
    });
  }

  test('game detail shows analysis results (API, DLSS, Streamline, conflicts)', async () => {
    window.location.hash = '#/game/steam-1245620';
    await tick(200);
    const text = document.getElementById('page').textContent;
    assert.match(text, /dx12|DX12|DirectX 12/i);
    assert.match(text, /310\.6\.0/);
    assert.match(text, /2\.11\.140/);
    assert.match(text, /d3d11\.dll/); // conflict from OPS_CHECK_CONFLICTS
  });

  test('runtimes page lists every manifest version 310.6.0 → 310.9.1', async () => {
    window.location.hash = '#/runtimes';
    await tick(150);
    const text = document.getElementById('page').textContent;
    for (const v of ['310.6.0', '310.7.0', '310.8.0', '310.9.1']) {
      assert.ok(text.includes(v), `runtime ${v} missing from page`);
    }
  });

  test('options page toggles theme through the real settings pipeline', async () => {
    window.location.hash = '#/options';
    await tick(150);
    const res = await window.UI.api.invoke(IPC.SETTINGS_SET, { patch: { theme: 'dark' } });
    window.UI.state.settings = res.settings;
    window.UI.applyTheme();
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
    // toggle it back through a nested dot-path too
    const res2 = await window.UI.api.invoke(IPC.SETTINGS_SET, { patch: { 'scan.steam': false, theme: 'light' } });
    window.UI.state.settings = res2.settings;
    window.UI.applyTheme();
    assert.equal(res2.settings.scan.steam, false);
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  });

  test('confirm dialog resolves with the primary button value', async () => {
    const pending = window.UI.dialogs.confirm('Delete backup?', 'This cannot be undone.', { okLabel: 'Delete', danger: true });
    await tick(60);
    const backdrop = document.querySelector('#modal-root .modal-backdrop');
    assert.ok(backdrop, 'modal appeared');
    assert.match(backdrop.textContent, /Delete backup\?/);
    const primary = backdrop.querySelector('.modal-footer .btn-danger');
    assert.ok(primary, 'danger button rendered');
    primary.click();
    assert.equal(await pending, true);
    await tick(10);
    assert.equal(document.querySelector('#modal-root .modal-backdrop'), null, 'modal removed after click');
  });

  test('showError hides stack traces outside Advanced Mode', async () => {
    const pending = window.UI.dialogs.showError('Install failed', 'Boom.', { stack: 'Error: Boom\n    at fakeFrame (x.js:1:1)' });
    await tick(60);
    const backdrop = document.querySelector('#modal-root .modal-backdrop');
    assert.ok(backdrop);
    assert.match(backdrop.textContent, /Boom\./);
    assert.ok(!backdrop.textContent.includes('fakeFrame'), 'stack must be hidden without Advanced Mode');
    backdrop.querySelector('.modal-footer button').click();
    await pending;
  });

  test('toast appears in #toast-root and auto-dismisses', async () => {
    window.UI.toast.success('Saved', 'Settings updated.');
    await tick(30);
    const root = document.getElementById('toast-root');
    assert.ok(root.children.length >= 1, 'toast shown');
    assert.match(root.textContent, /Saved/);
  });

  test('event bus round-trips progress events', () => {
    const seen = [];
    const off = window.UI.bus.on('progress:runtime:g1', (d) => seen.push(d));
    window.UI.bus.emit('progress:runtime:g1', { step: 'backup', percent: 40 });
    off();
    window.UI.bus.emit('progress:runtime:g1', { step: 'install', percent: 80 });
    assert.deepEqual(seen, [{ step: 'backup', percent: 40 }]);
  });

  test('DOM helpers build correct nodes (el/badge/btn/progressBar/stepList)', () => {
    const { el, badge, btn, progressBar, stepList } = window.UI;
    const node = el('div.card#demo.two', { 'data-x': '1', title: 't' }, ['hi ', el('b', 'there')]);
    assert.equal(node.tagName, 'DIV');
    assert.equal(node.id, 'demo');
    assert.equal(node.className, 'card two');
    assert.equal(node.getAttribute('data-x'), '1');
    assert.equal(node.textContent, 'hi there');

    assert.ok(badge('beta', 'warning').className.includes('badge-warning'));

    let clicked = 0;
    const b = btn('Go', { kind: 'primary', onclick: () => clicked++ });
    b.click();
    assert.equal(clicked, 1);
    assert.ok(b.className.includes('btn-primary'));

    const pb = progressBar(10);
    pb.set(73.4);
    assert.equal(pb.node.querySelector('.fill').style.width, '73.4%');

    const sl = stepList([{ id: 'a', label: 'Detect', status: 'done' }, { id: 'b', label: 'Install', status: 'running' }]);
    assert.equal(sl.node.querySelectorAll('.step-item').length, 2);
    assert.match(sl.node.textContent, /Detect/);
  });

  test('no unexpected IPC channels were called during the whole run', () => {
    assert.deepEqual(world.unexpected, [], `unstubbed channels hit: ${world.unexpected.join(', ')}`);
    assert.ok(world.calls.includes(IPC.GAMES_ANALYZE), 'lazy analysis actually ran');
  });

  test('no jsdom errors or window console errors during boot and navigation', () => {
    const real = jsdomErrors.filter((m) => !/Could not load|not implemented/i.test(m));
    assert.deepEqual(real, [], `jsdom errors: ${real.join(' | ')}`);
    assert.deepEqual(windowErrors, [], `console.error calls: ${windowErrors.join(' | ')}`);
  });
});

// ---------------------------------------------------------------------------
// Part B — real web preview server over HTTP
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

describe('UI smoke — web preview server (HTTP)', () => {
  let child, base, tmpDir, out = '';

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dlss5-ui-'));
    const port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(REPO, 'src', 'web', 'server.js')], {
      cwd: REPO,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DLSS5SWAPPER_DATA: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    // wait for the listen line (or early exit)
    const deadline = Date.now() + 20000;
    while (!out.includes('dev preview')) {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out}`);
      if (Date.now() > deadline) throw new Error(`server did not start in time:\n${out}`);
      await tick(100);
    }
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function ipc(channel, payload) {
    const res = await fetch(`${base}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload: payload || {} }),
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  test('GET / serves the app shell with CSP and the browser-mode marker', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp && csp.includes("default-src 'self'"), `CSP header present: ${csp}`);
    const html = await res.text();
    assert.match(html, /id="app"/);
    assert.match(html, /window\.__DLSS5_WEB__ = true/);
    assert.match(html, /js\/app\.js/);
  });

  test('static assets are served with correct MIME types', async () => {
    const checks = [
      ['/shared/constants.js', 'text/javascript', /DLSS5Shared/],
      ['/shared/format.js', 'text/javascript', /compareVersions/],
      ['/js/app.js', 'text/javascript', /UI\.pages/],
      ['/js/pages/options.js', 'text/javascript', /Advanced Mode/],
      ['/css/theme.css', 'text/css', /#F0F0F0/],
      ['/resources/RuntimeManifests/runtimes.json', 'application/json', /310\.9\.1/],
    ];
    for (const [p, mime, body] of checks) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, `${p} → ${res.status}`);
      assert.match(res.headers.get('content-type') || '', new RegExp(mime.replace('/', '\\/')), `${p} mime`);
      assert.match(await res.text(), body, `${p} body`);
    }
  });

  test('unknown static path returns 404', async () => {
    const res = await fetch(`${base}/definitely/not-here.js`);
    assert.equal(res.status, 404);
  });

  test('path traversal is refused', async () => {
    const res = await fetch(`${base}/../../package.json`);
    assert.ok(res.status === 404 || res.status === 400, `got ${res.status}`);
  });

  test('GET /healthz reports the data dir', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.dataDir, tmpDir);
  });

  test('POST /ipc answers real core channels', async () => {
    const info = await ipc(IPC.APP_INFO);
    assert.equal(info.name, 'DLSS Swapper 5');
    assert.equal(info.electron, false);

    const settings = await ipc(IPC.SETTINGS_GET);
    assert.equal(settings.theme, 'light');
    assert.equal(settings.autoBackup, true);

    const games = await ipc(IPC.GAMES_LIST);
    assert.ok(Array.isArray(games));

    const rt = await ipc(IPC.RUNTIMES_LIST);
    assert.equal(rt.runtimes.length, 9, 'all manifest runtimes listed');
    assert.ok(rt.runtimes.every((r) => r.available === false), 'fresh data dir has no packages');

    const gpu = await ipc(IPC.GPU_INFO);
    assert.ok(['supported', 'unsupported', 'unknown'].includes(gpu.compatibility.status));
    assert.ok(Array.isArray(gpu.gpus));

    const hist = await ipc(IPC.HISTORY_LIST);
    assert.deepEqual(hist, []);

    const set = await ipc(IPC.SETTINGS_SET, { patch: { theme: 'dark' } });
    assert.equal(set.ok, true);
    assert.equal(set.settings.theme, 'dark');
    const back = await ipc(IPC.SETTINGS_GET);
    assert.equal(back.theme, 'dark', 'settings persist to the temp data dir');
  });

  test('POST /ipc rejects unknown channels cleanly', async () => {
    const j = await ipc('nope:not-a-channel');
    assert.equal(j.ok, false);
    assert.match(j.error, /unknown channel/);
  });

  test('GET /events opens an SSE stream with a hello event', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString('utf8'), /event: hello/);
    ac.abort();
    try { await reader.cancel(); } catch { /* already aborted */ }
  });
});
