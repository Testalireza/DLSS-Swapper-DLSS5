'use strict';

/**
 * App shell: global state, hash router, topbar, sidebar, event plumbing.
 *
 * Pages are plain objects registered on UI.pages:
 *   { title, subtitle?(ctx), topbar?(ctx) → Node[], render(container, ctx), destroy?() }
 */
(function () {
  const { el, clear, $, $$ } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const api = window.UI.api;

  // ------------------------------------------------------------------ state
  const state = {
    appInfo: null,
    settings: null,
    games: [],
    gamesLoading: false,
    analysisCache: {},       // gameId → analysis
    gpu: null,
    runtimes: null,          // {runtimes:[...], providers:[...], loadErrors:[...]}
    lastScanAt: null,
  };
  window.UI.state = state;

  // Simple pub/sub used by pages for progress events
  const bus = {
    _subs: new Map(),
    on(key, fn) {
      if (!bus._subs.has(key)) bus._subs.set(key, new Set());
      bus._subs.get(key).add(fn);
      return () => bus.off(key, fn);
    },
    off(key, fn) {
      const set = bus._subs.get(key);
      if (set) set.delete(fn);
    },
    emit(key, data) {
      const set = bus._subs.get(key);
      if (set) for (const fn of set) { try { fn(data); } catch (e) { console.error(e); } }
    },
  };
  window.UI.bus = bus;

  // Core → UI progress events
  api.on(IPC.OPS_PROGRESS, (data) => {
    bus.emit(`progress:${data.op}:${data.gameId}`, data);
    bus.emit('progress:any', data);
  });
  api.on(IPC.GAMES_SCAN_PROGRESS, (data) => bus.emit('scanProgress', data));
  api.on(IPC.RUNTIMES_DOWNLOAD_PROGRESS, (data) => bus.emit('downloadProgress', data));

  // ------------------------------------------------------------- data loads

  async function loadAppInfo() {
    state.appInfo = await api.invoke(IPC.APP_INFO);
    const v = $('#sidebar-version');
    if (v && state.appInfo) {
      v.textContent = `v${state.appInfo.version}${state.appInfo.electron ? '' : ' · browser preview'}`;
    }
  }

  async function loadSettings() {
    const res = await api.invoke(IPC.SETTINGS_GET);
    state.settings = res && res.ok === false ? null : res;
    applyTheme();
  }

  function applyTheme() {
    const theme = (state.settings && state.settings.theme) || 'light';
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }
  window.UI.applyTheme = applyTheme;

  async function refreshGames(opts = {}) {
    state.gamesLoading = true;
    bus.emit('games:loading', true);
    try {
      const games = await api.invoke(IPC.GAMES_LIST);
      state.games = Array.isArray(games) ? games : [];
    } finally {
      state.gamesLoading = false;
      bus.emit('games:loading', false);
    }
    updateGamesCount();
    if (opts.rerender && currentRoute) renderRoute(currentRoute, { keepScroll: false });
    return state.games;
  }
  window.UI.refreshGames = refreshGames;

  async function scanGames() {
    state.gamesLoading = true;
    bus.emit('games:loading', true);
    bus.emit('scan:started', {});
    try {
      const games = await api.invoke(IPC.GAMES_SCAN);
      state.games = Array.isArray(games) ? games : [];
      state.lastScanAt = new Date().toISOString();
      state.analysisCache = {}; // versions may have changed
      window.UI.toast.success('Scan complete', `${state.games.length} game(s) in your library.`);
    } catch (err) {
      window.UI.dialogs.showError('Scan failed', err.message || String(err), { stack: err.stack });
    } finally {
      state.gamesLoading = false;
      bus.emit('games:loading', false);
      bus.emit('scan:finished', {});
    }
    updateGamesCount();
    return state.games;
  }
  window.UI.scanGames = scanGames;

  function updateGamesCount() {
    const badge = $('#nav-games-count');
    if (badge) {
      badge.textContent = String(state.games.length);
      badge.hidden = state.games.length === 0;
    }
  }

  /** Lazy per-game analysis with in-memory cache. */
  async function analysisFor(gameId, { refresh = false } = {}) {
    if (!refresh && state.analysisCache[gameId]) return state.analysisCache[gameId];
    const analysis = await api.invoke(IPC.GAMES_ANALYZE, { gameId });
    if (analysis && analysis.ok !== false) state.analysisCache[gameId] = analysis;
    return analysis;
  }
  window.UI.analysisFor = analysisFor;

  async function loadRuntimes() {
    state.runtimes = await api.invoke(IPC.RUNTIMES_LIST);
    return state.runtimes;
  }
  window.UI.loadRuntimes = loadRuntimes;

  async function loadGpu(refresh = false) {
    state.gpu = await api.invoke(IPC.GPU_INFO, { refresh });
    renderGpuChip();
    bus.emit('gpu:loaded', state.gpu);
    return state.gpu;
  }
  window.UI.loadGpu = loadGpu;

  function renderGpuChip() {
    const dot = $('#sidebar-gpu-dot');
    const text = $('#sidebar-gpu-text');
    if (!dot || !text) return;
    const g = state.gpu;
    if (!g) { text.textContent = 'Checking GPU…'; return; }
    const status = g.compatibility ? g.compatibility.status : 'unknown';
    dot.className = `gpu-chip-dot ${status}`;
    const nvidia = g.nvidia;
    text.textContent = nvidia ? `${nvidia.name} · ${status}` : `No NVIDIA GPU · ${status}`;
    const chip = $('#sidebar-gpu-chip');
    if (chip) {
      const reasons = g.compatibility ? [...(g.compatibility.reasons || []), ...(g.compatibility.warnings || [])].join('\n') : '';
      chip.setAttribute('data-tip', reasons ? `${text.textContent}\n\n${reasons}` : text.textContent);
      chip.onclick = () => navigate('#/dlss5');
      chip.style.cursor = 'pointer';
    }
  }

  // ----------------------------------------------------------------- router

  const routes = [
    { match: /^#\/games\/?$/, page: 'games', title: 'Games' },
    { match: /^#\/game\/(.+)$/, page: 'gameDetail', title: 'Game' },
    { match: /^#\/dlss5\/?$/, page: 'dlss5', title: 'DLSS 5 Neural Rendering' },
    { match: /^#\/runtimes\/?$/, page: 'runtimes', title: 'DLSS Runtime Library' },
    { match: /^#\/backups\/?$/, page: 'backups', title: 'Backups' },
    { match: /^#\/history\/?$/, page: 'history', title: 'Installation History' },
    { match: /^#\/options\/?$/, page: 'options', title: 'Options' },
    { match: /^#\/about\/?$/, page: 'about', title: 'About' },
  ];

  let currentRoute = null;
  let currentDestroy = null;

  function navigate(hash) {
    if (location.hash === hash) renderRoute(hash);
    else location.hash = hash;
  }
  window.UI.navigate = navigate;

  function matchRoute(hash) {
    for (const r of routes) {
      const m = hash.match(r.match);
      if (m) return { ...r, params: m.slice(1) };
    }
    return { ...routes[0], params: [] };
  }

  async function renderRoute(hash, opts = {}) {
    const route = matchRoute(hash || location.hash || '#/games');
    currentRoute = hash || location.hash || '#/games';

    // teardown previous page
    if (currentDestroy) { try { currentDestroy(); } catch { /* ignore */ } currentDestroy = null; }

    // sidebar active state
    for (const item of $$('.nav-item')) {
      const routeName = item.dataset.route;
      const active =
        (routeName === 'games' && (route.page === 'games' || route.page === 'gameDetail')) ||
        routeName === route.page;
      item.classList.toggle('active', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    }

    const page = window.UI.pages[route.page];
    const container = $('#page');
    const titleEl = $('#page-title');
    const subtitleEl = $('#page-subtitle');
    const actionsEl = $('#topbar-actions');

    clear(container);
    clear(actionsEl);

    if (!page) {
      titleEl.textContent = 'Not found';
      subtitleEl.textContent = '';
      container.appendChild(el('div.empty-state', [
        el('div.empty-icon', '🧭'),
        el('h3', 'Page not found'),
        el('p', `No page is registered for "${location.hash}".`),
        window.UI.btn('Go to Games', { kind: 'primary', onclick: () => navigate('#/games') }),
      ]));
      return;
    }

    const ctx = { state, params: route.params, navigate, refreshGames, scanGames, analysisFor, loadRuntimes, loadGpu, bus, route };
    titleEl.textContent = typeof page.title === 'function' ? page.title(ctx) : page.title;
    subtitleEl.textContent = '';

    try {
      if (page.topbar) {
        const actions = await page.topbar(ctx);
        for (const a of actions || []) actionsEl.appendChild(a);
      }
      await page.render(container, ctx);
      if (page.subtitle) subtitleEl.textContent = await page.subtitle(ctx);
      if (page.destroy) currentDestroy = page.destroy;
    } catch (err) {
      console.error('page render failed', err);
      container.appendChild(el('div.banner.banner-danger', [
        el('div', '⚠️'),
        el('div.banner-body', [
          el('strong', 'This page failed to render'),
          el('div', err.message || String(err)),
        ]),
      ]));
    }
    if (!opts.keepScroll) container.scrollTop = 0;
    container.focus({ preventScroll: true });
  }

  window.addEventListener('hashchange', () => renderRoute(location.hash));
  if (window.dlss5 && window.dlss5.on) {
    window.dlss5.on('ui:rescan', () => scanGames().then(() => renderRoute(currentRoute)));
  }

  // ------------------------------------------------------------------- init

  async function init() {
    await loadAppInfo();
    await loadSettings();
    await refreshGames();
    // Non-blocking background loads
    loadGpu().catch(() => {});
    loadRuntimes().catch(() => {});
    document.getElementById('app').setAttribute('aria-busy', 'false');
    if (!location.hash) location.hash = '#/games';
    renderRoute(location.hash);
  }

  window.UI.reloadSettings = async function () {
    await loadSettings();
    bus.emit('settings:changed', state.settings);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
