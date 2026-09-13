'use strict';

/**
 * Options page (spec §2) — appearance, scanning, backups, safety, logging,
 * runtime sources, Advanced Mode and app maintenance.
 */
(function () {
  const { el, clear, badge, btn } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { formatDateTimeShort } = window.DLSS5Shared;
  const api = window.UI.api;

  async function setSetting(key, value, ctx) {
    const res = await api.invoke(IPC.SETTINGS_SET, { patch: { [key]: value } });
    if (res && res.settings) {
      ctx.state.settings = res.settings;
      window.UI.applyTheme();
      window.UI.bus.emit('settings:changed', res.settings);
    }
    return res;
  }

  function toggle(label, desc, key, ctx, opts = {}) {
    const s = ctx.state.settings || {};
    const get = () => {
      const parts = key.split('.');
      let v = s;
      for (const p of parts) v = v == null ? undefined : v[p];
      return !!v;
    };
    return el('div.field', [
      el('div.field-info', [
        el('div.field-label', [label, opts.beta ? badge('beta', 'warning') : null]),
        desc ? el('div.field-desc', desc) : null,
      ]),
      el('label.toggle', opts.tip ? { 'data-tip': opts.tip } : null, [
        el('input', {
          type: 'checkbox',
          checked: get() || undefined,
          'aria-label': label,
          onchange: async (e) => {
            await setSetting(key, e.target.checked, ctx);
            if (opts.onchange) opts.onchange(e.target.checked, ctx);
          },
        }),
        el('span.track'), el('span.thumb'),
      ]),
    ]);
  }

  function section(title, children, note) {
    return el('div.card', [
      el('h2.card-title', title),
      note ? el('p.section-note', note) : null,
      children,
    ]);
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.options = {
    title: 'Options',
    subtitle: () => 'Settings are stored in your app data folder and applied immediately',
    render: async (container, ctx) => {
      const rerender = async () => { clear(container); await renderAll(); };
      async function renderAll() {
        if (!ctx.state.settings) await window.UI.reloadSettings();
        const s = ctx.state.settings || {};

        // ---------------- Appearance ----------------
        const themeSelect = el('select', {
          'aria-label': 'Theme',
          onchange: (e) => setSetting('theme', e.target.value, ctx),
        }, [
          el('option', { value: 'light', selected: s.theme === 'light' || undefined }, 'Light (#F0F0F0)'),
          el('option', { value: 'dark', selected: s.theme === 'dark' || undefined }, 'Dark'),
        ]);
        container.appendChild(section('🎨 Appearance', [
          el('div.field', [
            el('div.field-info', [el('div.field-label', 'Application theme'), el('div.field-desc', 'Light uses the #F0F0F0 background with the #8BCA84 accent.')]),
            el('div.field-control', themeSelect),
          ]),
          toggle('Compact game cards', 'Show more games per row in the library.', 'compactGameCards', ctx),
        ]));

        // ---------------- Game scanning ----------------
        const foldersList = el('div.chip-list', { style: 'margin-top:8px' },
          (s.customGameFolders || []).map((f) => el('span.chip', [
            f,
            el('button', {
              'aria-label': `Remove ${f}`,
              onclick: async () => {
                const next = (s.customGameFolders || []).filter((x) => x !== f);
                await setSetting('customGameFolders', next, ctx);
                rerender();
              },
            }, '✕'),
          ]))
        );
        container.appendChild(section('🔎 Game scanning', [
          toggle('Steam', 'Scan Steam libraries (all library folders via libraryfolders.vdf).', 'scan.steam', ctx),
          toggle('Epic Games', 'Scan the Epic Games Launcher manifest store.', 'scan.epic', ctx),
          toggle('Xbox / Microsoft Store', 'Scan C:\\XboxGames and configured install paths (WindowsApps is OS-locked and skipped).', 'scan.xbox', ctx),
          toggle('GOG', 'Scan GOG Galaxy registry entries and the default GOG Games folder.', 'scan.gog', ctx),
          toggle('Custom folders', 'Scan the folders listed below for game installations.', 'scan.customFolders', ctx),
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'Custom game folders'),
              el('div.field-desc', 'Extra locations to scan (external drives, non-standard installs). Scanned up to the depth below.'),
              foldersList,
            ]),
            el('div.field-control', [
              btn('➕ Add folder', {
                onclick: async () => {
                  const p = await api.pickFolder('Select a folder to scan for games');
                  if (!p) return;
                  const next = [...new Set([...(s.customGameFolders || []), p])];
                  await setSetting('customGameFolders', next, ctx);
                  rerender();
                },
              }),
            ]),
          ]),
          el('div.field', [
            el('div.field-info', [el('div.field-label', 'Scan depth'), el('div.field-desc', 'How deep custom folder scanning descends (1–6).')]),
            el('div.field-control', el('input', {
              type: 'number', min: 1, max: 6, value: String(s.scanDepth || 3), style: 'width:70px',
              onchange: async (e) => { await setSetting('scanDepth', Math.max(1, Math.min(6, Number(e.target.value) || 3)), ctx); },
            })),
          ]),
        ]));

        // ---------------- Backups ----------------
        container.appendChild(section('🗄 Backups', [
          toggle('Automatically create backups before modifications', 'Strongly recommended. Every replaced file is preserved with hashes and metadata before anything is written.', 'autoBackup', ctx, {
            tip: 'With this disabled, installs proceed without a safety net (only for advanced users).',
          }),
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'Backup location'),
              el('div.field-desc', s.backupDir ? el('span.mono', s.backupDir) : el('span.mono', 'Default (app data folder)')),
            ]),
            el('div.field-control', [
              btn('Change…', {
                onclick: async () => {
                  const p = await api.pickFolder('Select the backup root folder');
                  if (!p) return;
                  await setSetting('backupDir', p, ctx);
                  rerender();
                },
              }),
              s.backupDir ? btn('Reset to default', { onclick: async () => { await setSetting('backupDir', null, ctx); rerender(); } }) : null,
              btn('📂 Open', { onclick: () => api.openFolderVia(IPC.BACKUPS_OPEN_FOLDER, {}) }),
            ]),
          ]),
        ], 'Backups preserve original file names, directory structure, hashes, timestamps and the detected runtime version. Existing backups are never overwritten.'));

        // ---------------- Safety ----------------
        container.appendChild(section('🛡 Safety & verification', [
          toggle('Verify files after installation', 'Re-hash and (where possible) re-read version metadata of every installed file. Failures trigger an automatic rollback from the backup.', 'verifyAfterInstall', ctx),
          toggle('Warn about conflicts', 'Pause installs when proxy DLLs or other tools (ReShade, OptiScaler, Special K…) are detected next to the executable.', 'warnOnConflicts', ctx),
          toggle('Block installs while the game is running', 'Refuse modifications when the game process is detected.', 'blockIfGameRunning', ctx),
        ]));

        // ---------------- Advanced ----------------
        container.appendChild(section('🧪 Advanced Mode', [
          toggle('Enable Advanced Mode', 'Unlocks: manual executable/DLL/streamline folder selection, force install, compatibility overrides, hash details and verbose technical logging.', 'advancedMode', ctx, {
            onchange: () => rerender(),
          }),
          s.advancedMode ? el('div', { style: 'margin-top:6px' }, [
            toggle('Show advanced technical information', 'Hashes, file sizes, stack traces in error dialogs, detection evidence.', 'showAdvancedInfo', ctx),
            toggle('Verbose logging', 'Write DEBUG-level detail to the log files.', 'verboseLogging', ctx),
            toggle('GPU compatibility override', 'Skip the RTX compatibility gate for DLSS 5 injection installs.', 'gpuCompatibilityOverride', ctx),
            el('div.field', [
              el('div.field-info', [
                el('div.field-label', 'Manual selections'),
                el('div.field-desc', 'Advanced Mode adds an executable picker on each game page (Game analysis → Choose the game executable manually), manual DLL path entry in import dialogs, and per-file role/rename editing for injection packages.'),
              ]),
            ]),
          ]) : null,
        ]));

        // ---------------- Logging ----------------
        const recentLogs = el('div.log-view', 'Loading…');
        (async () => {
          const entries = (await api.invoke(IPC.LOGS_RECENT, { limit: 40 })) || [];
          clear(recentLogs);
          if (!entries.length) recentLogs.textContent = '(log is empty)';
          for (const e of entries.slice().reverse()) {
            recentLogs.appendChild(el('div', { class: `lv-${e.level}` },
              `[${formatDateTimeShort(e.ts)}] [${e.level}] ${e.message}`));
          }
        })();
        container.appendChild(section('📄 Logging', [
          toggle('Enable logging', 'Write the application log to daily files in your data folder.', 'loggingEnabled', ctx),
          el('div.field', [
            el('div.field-info', [el('div.field-label', 'Recent log entries')]),
            el('div.field-control', [
              btn('📂 Open log folder', { onclick: () => api.openFolderVia(IPC.LOGS_OPEN_FOLDER) }),
              btn('⬇ Export log…', {
                onclick: async () => {
                  const r = await api.invoke(IPC.LOGS_EXPORT);
                  if (r && r.ok) window.UI.toast.success('Log exported', r.file);
                  else if (r && r.browserMode) window.UI.toast.info('Desktop only', 'Log export uses the native save dialog in the Windows app.');
                  else if (r && r.canceled) { /* user cancelled */ }
                },
              }),
              btn('⟳', { onclick: () => rerender(), ariaLabel: 'Refresh log view' }),
            ]),
          ]),
          recentLogs,
        ]));

        // ---------------- Runtime sources ----------------
        const gh = (s.runtimeSources && s.runtimeSources.github) || { enabled: true, repos: [] };
        const repoList = el('div', { style: 'display:flex; flex-direction:column; gap:6px; margin-top:6px' },
          (gh.repos || []).map((tpl, i) => el('div', { style: 'display:flex; gap:6px' }, [
            el('input', {
              type: 'text', value: tpl, style: 'flex:1', 'aria-label': `Source template ${i + 1}`,
              onchange: async (e) => {
                const repos = [...(gh.repos || [])];
                repos[i] = e.target.value.trim();
                await setSetting('runtimeSources', { ...s.runtimeSources, github: { ...gh, repos: repos.filter(Boolean) } }, ctx);
              },
            }),
            btn('✕', {
              size: 'sm', kind: 'ghost', ariaLabel: 'Remove template',
              onclick: async () => {
                const repos = (gh.repos || []).filter((_, j) => j !== i);
                await setSetting('runtimeSources', { ...s.runtimeSources, github: { ...gh, repos } }, ctx);
                rerender();
              },
            }),
          ]))
        );
        container.appendChild(section('🌐 Runtime repository management', [
          toggle('GitHub provider', 'Try GitHub release assets when downloading runtimes.', 'runtimeSources.github.enabled', ctx),
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'GitHub source URL templates'),
              el('div.field-desc', 'Placeholders: {version} → runtime version, {file} → file name. Tried in order; failed downloads fall back to manual import.'),
              repoList,
            ]),
            el('div.field-control', [
              btn('➕ Add template', {
                onclick: async () => {
                  const repos = [...(gh.repos || []), 'https://github.com/OWNER/REPO/releases/download/{version}/{file}'];
                  await setSetting('runtimeSources', { ...s.runtimeSources, github: { ...gh, repos } }, ctx);
                  rerender();
                },
              }),
            ]),
          ]),
          el('div.field', [
            el('div.field-info', [el('div.field-label', 'Local library'), el('div.field-desc', 'Imported and downloaded packages live here (validated + hashed).')]),
            el('div.field-control', [
              btn('📂 Open Runtime Library', { onclick: () => api.openFolderVia(IPC.RUNTIMES_OPEN_LIBRARY) }),
              btn('Manage versions…', { onclick: () => window.UI.navigate('#/runtimes') }),
            ]),
          ]),
        ]));

        // ---------------- App ----------------
        container.appendChild(section('🧰 Application', [
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'Check for application updates'),
              el('div.field-desc', `Current version: v${(ctx.state.appInfo && ctx.state.appInfo.version) || '?'} — updates are published on GitHub Releases.`),
            ]),
            el('div.field-control', [
              btn('Check now', {
                onclick: async (ev) => {
                  const b = ev.currentTarget;
                  b.disabled = true; b.textContent = 'Checking…';
                  const r = await api.invoke(IPC.APP_CHECK_UPDATE);
                  b.disabled = false; b.textContent = 'Check now';
                  if (r && r.ok && r.updateAvailable) {
                    await window.UI.dialogs.open({
                      icon: '🎉', title: `Version ${r.latest.version} is available`,
                      body: [el('div', r.latest.name), el('p', `Published ${formatDateTimeShort(r.latest.publishedAt)}.`), el('div.log-view', r.latest.body || '(no release notes)')],
                      buttons: [{ label: 'Close', value: false }, { label: 'Open release page', value: true, kind: 'primary' }],
                    }).then((open) => { if (open && r.latest.url) window.open(r.latest.url, '_blank'); });
                  } else if (r && r.ok) {
                    window.UI.toast.success('Up to date', r.message || `You are running the latest version (v${r.current}).`);
                  } else {
                    await window.UI.dialogs.showError('Update check failed', (r && r.error) || 'Unknown error');
                  }
                },
              }),
            ]),
          ]),
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'Application data folder'),
              el('div.field-desc', el('span.mono', (ctx.state.appInfo && ctx.state.appInfo.dataDir) || '')),
            ]),
            el('div.field-control', [btn('📂 Open', { onclick: () => api.openFolderVia(IPC.SETTINGS_OPEN_DATA_DIR) })]),
          ]),
          el('div.field', [
            el('div.field-info', [
              el('div.field-label', 'Reset application settings'),
              el('div.field-desc', 'Restores all defaults. Your current settings file is archived next to it — games, backups, libraries and history are not touched.'),
            ]),
            el('div.field-control', [
              btn('Reset settings…', {
                kind: 'danger',
                onclick: async () => {
                  const ok = await window.UI.dialogs.confirm('Reset all settings?',
                    'Theme, scanning, backup location, safety toggles and provider configuration return to defaults. The old settings file is archived automatically.',
                    { okLabel: 'Reset', danger: true, icon: '♻️' });
                  if (!ok) return;
                  await api.invoke(IPC.SETTINGS_RESET);
                  await window.UI.reloadSettings();
                  window.UI.toast.success('Settings reset', 'All options restored to defaults.');
                  rerender();
                },
              }),
            ]),
          ]),
        ]));
      }
      await renderAll();
    },
  };
})();
