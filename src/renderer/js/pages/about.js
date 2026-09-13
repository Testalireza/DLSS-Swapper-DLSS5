'use strict';

/**
 * About page — application identity, what it does, safety promises,
 * inspirations/credits and useful links. No network calls; renders from
 * ctx.state.appInfo (IPC.APP_INFO).
 */
(function () {
  const { el, badge, btn } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const api = window.UI.api;

  function kv(label, value) {
    return [el('dt', label), el('dd', value)];
  }

  function link(href, text) {
    return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text || href);
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.about = {
    title: 'About',
    subtitle: () => 'DLSS Swapper 5 — DLSS runtime manager with DLSS 5 Neural Rendering support',
    render: async (container, ctx) => {
      const info = ctx.state.appInfo || {};

      // ------------------------------------------------------------- header
      container.appendChild(el('div.card.about-hero', [
        el('div.about-logo', { 'aria-hidden': 'true' }, '🎮'),
        el('div', [
          el('h2', { style: 'margin:0' }, [
            info.name || 'DLSS Swapper 5',
            ' ',
            badge(`v${info.version || '?'}`, 'success'),
            info.electron ? badge('Windows app') : badge('browser preview', 'warning'),
          ]),
          el('p.section-note', { style: 'margin-top:6px' },
            'Detect your games, manage DLSS runtime versions with verified backups, and enable DLSS 5 Neural Rendering through OptiScaler or ReShade injection — safely.'),
        ]),
      ]));

      // ---------------------------------------------------------- what it is
      container.appendChild(el('div.card', [
        el('h2.card-title', 'What this application does'),
        el('ul.feature-list', [
          el('li', [el('strong', 'Game detection — '), 'scans Steam, Epic Games, Xbox / Microsoft Store, GOG Galaxy and your custom folders, or lets you add any game manually.']),
          el('li', [el('strong', 'Real analysis — '), 'reads the game executable’s PE import table to identify the graphics API (DX11/DX12/Vulkan) and parses DLL version resources and content hashes to identify nvngx_dlss.dll / nvngx_streamline.dll builds. Never filename-based.']),
          el('li', [el('strong', 'Runtime version management — '), 'a JSON manifest database (310.6.0 → 310.9.1 and beyond) with pluggable sources: local library, GitHub release providers, and user imports validated by structure, names and SHA-256 hashes.']),
          el('li', [el('strong', 'Backup-first modifications — '), 'every file that would be replaced is copied into a timestamped, hash-verified backup before anything is written. Installs run as detect → backup → validate → stage → install → verify, and any failure rolls back automatically.']),
          el('li', [el('strong', 'DLSS 5 Neural Rendering — '), 'imports community injection packages and installs them through OptiScaler or ReShade with GPU compatibility detection (RTX 20/30/40/50), append-only config merging, and full uninstall-and-restore.']),
          el('li', [el('strong', 'Conflict awareness — '), 'detects existing proxy DLLs and other tools (ReShade, OptiScaler, Special K…) next to the executable and asks before proceeding. It never silently deletes your files.']),
        ]),
      ]));

      // ------------------------------------------------------- safety pledge
      container.appendChild(el('div.card', [
        el('h2.card-title', '🛡 Safety promises'),
        el('ul.feature-list', [
          el('li', 'No game file is ever modified without a completed backup first (unless you explicitly disable auto-backup in Options).'),
          el('li', 'Existing backups are never overwritten — each operation creates a new one.'),
          el('li', 'Restores verify preserved-file hashes before writing, and files you changed yourself after an install are kept, never deleted.'),
          el('li', 'Installs that fail verification roll back to the pre-install state automatically.'),
          el('li', 'Modifications are refused while the game process is running.'),
          el('li', 'Conflicting third-party files are reported, never auto-removed.'),
        ]),
      ]));

      // ------------------------------------------------------- app info card
      container.appendChild(el('div.card', [
        el('h2.card-title', 'Application information'),
        el('dl.kv-grid', [
          ...kv('Name', info.name || '—'),
          ...kv('Version', `v${info.version || '?'}`),
          ...kv('License', info.license || 'MIT'),
          ...kv('Platform', info.platform || navigator.platform || '—'),
          ...kv('Running as', info.electron ? 'Electron desktop app' : 'Zero-dependency browser preview (same core services)'),
          ...kv('Data folder', el('span.mono', info.dataDir || '—')),
          ...kv('Resources', el('span.mono', info.resourcesDir || '—')),
        ]),
        el('div', { style: 'display:flex; gap:8px; margin-top:12px; flex-wrap:wrap' }, [
          btn('📂 Open data folder', { onclick: () => api.openFolderVia(IPC.SETTINGS_OPEN_DATA_DIR) }),
          btn('📄 Open logs', { onclick: () => api.openFolderVia(IPC.LOGS_OPEN_FOLDER) }),
          btn('🗄 Open backups', { onclick: () => api.openFolderVia(IPC.BACKUPS_OPEN_FOLDER, {}) }),
        ]),
      ]));

      // ------------------------------------------------------------ credits
      container.appendChild(el('div.card', [
        el('h2.card-title', 'Credits & inspiration'),
        el('p.section-note', 'This is an original implementation. The following public projects inspired its architecture and UX; no code or assets were copied:'),
        el('ul.feature-list', [
          el('li', [link('https://github.com/rakanki911/DLSS5-Swapper', 'rakanki911/DLSS5-Swapper'), ' — workflow and layout inspiration: sidebar navigation, game cards with API/DLSS status badges, hash-based build identification, backup-everything semantics.']),
          el('li', [link('https://github.com/RankFTW/RHI', 'RankFTW/RHI'), ' — injection and configuration concepts: OptiScaler DLSS-NR variant tooling, ReShade add-on installation and INI handling.']),
        ]),
        el('p.section-note', { style: 'margin-top:10px' }, [
          'Built with ', el('strong', 'Electron'), ' and vanilla JavaScript. Zero runtime dependencies — PE parsing, VDF parsing, INI merging, hashing, backups and the web preview server are all implemented in this repository. Tests run on ', el('code', 'node:test'), ' with a jsdom UI smoke suite.',
        ]),
      ]));

      // -------------------------------------------------------------- links
      container.appendChild(el('div.card', [
        el('h2.card-title', 'Links'),
        el('dl.kv-grid', [
          ...kv('Repository', link(info.repository || 'https://github.com/Testalireza/DLSS-Swapper-DLSS5')),
          ...kv('Report an issue', link('https://github.com/Testalireza/DLSS-Swapper-DLSS5/issues')),
          ...kv('Releases', link('https://github.com/Testalireza/DLSS-Swapper-DLSS5/releases')),
        ]),
      ]));

      // ---------------------------------------------------------- disclaimer
      container.appendChild(el('div.banner.banner-warning', [
        el('div', '⚠️'),
        el('div.banner-body', [
          el('strong', 'Disclaimer'),
          el('div', 'This project is not affiliated with, endorsed by, or sponsored by NVIDIA Corporation. DLSS® and GeForce RTX™ are trademarks of NVIDIA Corporation. Modifying game files may violate some games’ terms of service and can trigger anti-cheat detections in online games — use injection features in single-player/offline contexts at your own risk. Always keep your backups.'),
        ]),
      ]));
    },
  };
})();
