'use strict';

/**
 * Games page — library grid with search, rescan and manual add.
 * Cards show provider, graphics API, DLSS version and injection status,
 * filled in lazily as each game's analysis completes (like the reference).
 */
(function () {
  const { el, clear, badge, coverTile, btn, $ } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const api = window.UI.api;

  let searchTerm = '';
  let sortBy = 'name';
  let cardRefs = new Map(); // gameId → card element
  let unsubLoading = null;
  let unsubScan = null;

  function providerLabel(p) {
    return { steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox / MS Store', gog: 'GOG', manual: 'Manual', folder: 'Custom folder' }[p] || p;
  }

  function sortGames(games) {
    const arr = [...games];
    if (sortBy === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (sortBy === 'provider') arr.sort((a, b) => (a.provider + a.name).localeCompare(b.provider + b.name));
    if (sortBy === 'recent') arr.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    return arr;
  }

  function filterGames(games) {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) =>
      g.name.toLowerCase().includes(q) ||
      (g.installDir || '').toLowerCase().includes(q) ||
      providerLabel(g.provider).toLowerCase().includes(q)
    );
  }

  function gameCard(game) {
    const nameEl = el('div.game-card-name', game.name);
    const metaEl = el('div.game-card-meta', [badge('analyzing…')]);
    const card = el('button.game-card.card', {
      onclick: (e) => {
        if (e.target.closest('.game-card-actions')) return;
        window.UI.navigate(`#/game/${encodeURIComponent(game.id)}`);
      },
      'aria-label': `Open ${game.name}`,
    }, [
      el('div.game-card-actions', [
        btn('🗀', {
          size: 'sm', kind: 'ghost', tip: 'Open install folder', ariaLabel: `Open folder of ${game.name}`,
          onclick: () => api.openPath(game.installDir),
        }),
        game.provider === 'manual'
          ? btn('✕', {
              size: 'sm', kind: 'ghost', tip: 'Remove from library (files are never deleted)', ariaLabel: `Remove ${game.name}`,
              onclick: async () => {
                const ok = await window.UI.dialogs.confirm('Remove manual game?', [
                  el('div', [el('strong', game.name), ' will be removed from your library.']),
                  el('p', 'No files are deleted — only the entry this app tracks.'),
                ], { okLabel: 'Remove', danger: true });
                if (!ok) return;
                await api.invoke(IPC.GAMES_REMOVE, { gameId: game.id });
                window.UI.toast.info('Removed', `${game.name} removed from the library.`);
                await window.UI.refreshGames({ rerender: true });
              },
            })
          : btn('👁', {
              size: 'sm', kind: 'ghost', tip: 'Hide from library (ignored list in settings)', ariaLabel: `Hide ${game.name}`,
              onclick: async () => {
                await api.invoke(IPC.GAMES_IGNORE, { gameId: game.id, ignored: true });
                window.UI.toast.info('Hidden', `${game.name} hidden. Manage ignored games in Options → Game scanning.`);
                await window.UI.refreshGames({ rerender: true });
              },
            }),
      ]),
      el('div.game-card-head', [
        coverTile(game.name),
        el('div', { style: 'min-width:0' }, [
          nameEl,
          el('div.game-card-provider', `${providerLabel(game.provider)} · ${game.installDir}`),
        ]),
      ]),
      metaEl,
    ]);

    // Lazily analyze and fill meta chips
    (async () => {
      try {
        const a = await window.UI.analysisFor(game.id);
        clear(metaEl);
        if (!a || a.ok === false) {
          metaEl.appendChild(badge('analysis failed', 'warning', a && a.error ? a.error : (a && a.errors || []).join(' ')));
          return;
        }
        const apis = (a.graphicsApi || []).map((x) => x.api);
        metaEl.appendChild(badge(apis.length ? apis.join(' · ') : 'API unknown', apis.length ? 'info' : ''));
        if (a.dlss.detected) {
          metaEl.appendChild(badge(`DLSS ${a.dlss.primaryVersion || '?'}`, 'accent', `Detected via ${a.dlss.versionSource}`));
        } else {
          metaEl.appendChild(badge('No DLSS', '', 'No nvngx_dlss.dll found next to the executable'));
        }
        if (a.streamline.detected) metaEl.appendChild(badge(`Streamline ${a.streamline.version || '✓'}`, 'accent'));
        if (a.injection.installed) metaEl.appendChild(badge('DLSS 5 ✓', 'success', `Injection installed (${a.injection.method || 'method unknown'})`));
        if (a.is64bit === false) metaEl.appendChild(badge('32-bit', 'warning', '32-bit game — 64-bit runtimes will not work'));
      } catch (err) {
        clear(metaEl);
        metaEl.appendChild(badge('analysis failed', 'warning', err.message));
      }
    })();

    return card;
  }

  async function addGameDialog() {
    const nameInput = el('input', { type: 'text', placeholder: 'Game name (optional)', style: 'width:100%' });
    const folderInput = el('input', { type: 'text', placeholder: 'Game install folder (required)', style: 'width:100%' });
    const exeInput = el('input', { type: 'text', placeholder: 'Executable path (optional — auto-detected)', style: 'width:100%' });
    const row = (label, input, extra) => el('div', { style: 'margin-bottom:12px' }, [
      el('label', { style: 'display:block; font-weight:600; font-size:12.5px; margin-bottom:4px' }, label),
      el('div', { style: 'display:flex; gap:6px' }, [input, extra]),
    ]);
    const pickFolderBtn = btn('Browse…', { size: 'sm', onclick: async () => { const p = await api.pickFolder('Select the game install folder'); if (p) folderInput.value = p; } });
    const pickExeBtn = btn('Browse…', { size: 'sm', onclick: async () => { const fs = await api.pickFiles('Select the game executable', ['exe']); if (fs && fs.length) exeInput.value = fs[0]; } });

    const ok = await window.UI.dialogs.open({
      icon: '➕',
      title: 'Add game manually',
      wide: true,
      body: [
        el('p', 'For games the scanners missed. Point at the install folder — the executable and DLSS files are detected automatically.'),
        row('Name', nameInput, null),
        row('Install folder', folderInput, pickFolderBtn),
        row('Executable', exeInput, pickExeBtn),
      ],
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Add game', value: true, kind: 'primary', autofocus: true },
      ],
    });
    if (!ok) return;
    const res = await api.invoke(IPC.GAMES_ADD_MANUAL, {
      name: nameInput.value.trim() || undefined,
      installDir: folderInput.value.trim(),
      exePath: exeInput.value.trim() || undefined,
    });
    if (res && res.ok) {
      window.UI.toast.success('Game added', `${nameInput.value.trim() || folderInput.value.trim()} is now in your library.`);
      await window.UI.refreshGames({ rerender: true });
    } else {
      await window.UI.dialogs.showError('Could not add game', (res && res.error) || 'Unknown error', { stack: res && res.stack });
    }
  }

  function renderGrid(container) {
    const grid = el('div.card-grid');
    container.appendChild(grid);
    cardRefs = new Map();
    const games = sortGames(filterGames(window.UI.state.games));
    if (!games.length) {
      const anyGames = window.UI.state.games.length > 0;
      grid.appendChild(el('div.empty-state', { style: 'grid-column: 1 / -1' }, [
        el('div.empty-icon', anyGames ? '🔍' : '🎮'),
        el('h3', anyGames ? 'No games match your search' : 'No games found yet'),
        el('p', anyGames
          ? 'Try a different search term.'
          : 'Scan your PC for Steam, Epic, Xbox and GOG installations, add a custom folder in Options, or add a game manually.'),
        el('div.btn-row', { style: 'justify-content:center' }, [
          btn('⟳ Scan for games', { kind: 'primary', onclick: () => window.UI.scanGames().then(() => renderRouteNow()) }),
          btn('➕ Add game manually', { onclick: addGameDialog }),
        ]),
      ]));
      return;
    }
    for (const g of games) {
      const card = gameCard(g);
      cardRefs.set(g.id, card);
      grid.appendChild(card);
    }
  }

  function renderRouteNow() {
    // Re-render current page in place
    const container = $('#page');
    clear(container);
    renderGrid(container);
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.games = {
    title: 'Games',
    subtitle: (ctx) => `${ctx.state.games.length} game(s) in your library`,
    topbar: (ctx) => {
      const searchInput = el('input', {
        type: 'text',
        placeholder: 'Search games…',
        value: searchTerm,
        'aria-label': 'Search games',
        oninput: (e) => { searchTerm = e.target.value; renderRouteNow(); },
      });
      const sortSelect = el('select', { 'aria-label': 'Sort games', onchange: (e) => { sortBy = e.target.value; renderRouteNow(); } }, [
        el('option', { value: 'name', selected: sortBy === 'name' || undefined }, 'Sort: Name'),
        el('option', { value: 'provider', selected: sortBy === 'provider' || undefined }, 'Sort: Provider'),
        el('option', { value: 'recent', selected: sortBy === 'recent' || undefined }, 'Sort: Recently added'),
      ]);
      return [
        el('div.search-wrap', [
          el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' }),
          searchInput,
        ]),
        sortSelect,
        btn('⟳ Rescan', { onclick: () => ctx.scanGames().then(() => renderRouteNow()), tip: 'Re-run all enabled game detectors (F5)' }),
        btn('➕ Add game', { kind: 'primary', onclick: addGameDialog }),
      ];
    },
    render: async (container, ctx) => {
      if (ctx.state.gamesLoading) {
        container.appendChild(el('div.page-loading', 'Scanning…'));
      }
      renderGrid(container);
      unsubLoading = ctx.bus.on('games:loading', () => renderRouteNow());
      unsubScan = ctx.bus.on('scan:finished', () => renderRouteNow());
    },
    destroy: () => {
      if (unsubLoading) unsubLoading();
      if (unsubScan) unsubScan();
      unsubLoading = unsubScan = null;
    },
  };
})();
