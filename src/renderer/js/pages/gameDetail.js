'use strict';

/**
 * Game detail page — analysis (spec §13), version switching (§8), restore
 * (§7), conflicts (§15), per-game backups and injection status.
 */
(function () {
  const { el, clear, badge, btn, statusRow, stepList, progressBar } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { compareVersions, formatDateTimeShort, formatBytes } = window.DLSS5Shared;
  const api = window.UI.api;

  let unsubs = [];
  let selectedVersion = null;

  function decodeGameId(raw) {
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  /**
   * Run an install with a live step dialog. Resolves with the operation result.
   */
  async function runInstallWithDialog({ title, intro, gameId, channel, payload, progressKey }) {
    const steps = stepList([]);
    const progress = progressBar(null);
    let closeDialog = null;
    let result = null;

    const dialogPromise = window.UI.dialogs.open({
      icon: '⚙️',
      title,
      wide: true,
      dismissable: false,
      body: [el('div', intro), progress.node, steps.node],
      buttons: [{ label: 'Close', value: 'closed', disabled: true }],
    });

    // Re-render footer button when finished: dialogs are immutable, so we
    // resolve by flipping a flag the Close button already has (it is enabled
    // after completion by re-dispatching through the modal DOM).
    const enableClose = () => {
      const backdrops = document.querySelectorAll('#modal-root .modal-backdrop');
      const last = backdrops[backdrops.length - 1];
      if (last) last.querySelectorAll('.modal-footer .btn').forEach((b) => { b.disabled = false; });
    };

    const off = window.UI.bus.on(progressKey, (data) => {
      if (data.steps) steps.render(data.steps);
      if (typeof data.percent === 'number') progress.set(data.percent);
      else progress.set(null);
    });

    try {
      result = await api.invoke(channel, payload);
      if (result && result.steps) steps.render(result.steps.map((s) => ({ ...s })));
      progress.set(100);
    } catch (err) {
      result = { ok: false, error: err.message, stack: err.stack };
      progress.set(100);
    } finally {
      off();
      enableClose();
    }
    await dialogPromise;
    return result;
  }

  async function handleInstall(game, ctx) {
    if (!selectedVersion) return;
    const settings = ctx.state.settings || {};

    // Pre-flight: game running?
    const running = await api.invoke(IPC.GAMES_IS_RUNNING, { gameId: game.id });
    if (running && running.running && settings.blockIfGameRunning && !settings.advancedMode) {
      await window.UI.dialogs.showError(
        `${game.name} is running`,
        'The game process is currently running. Files cannot be replaced safely while the game holds them open.',
        { hint: 'Close the game and try again. Advanced Mode users can force the install from Options.', stack: null }
      );
      return;
    }

    let payload = { gameId: game.id, version: selectedVersion, force: !!settings.advancedMode && !!settings.forceInstall };
    let result = await runInstallWithDialog({
      title: `Installing runtime ${selectedVersion}`,
      intro: [el('strong', game.name), ` → DLSS runtime ${selectedVersion}`],
      gameId: game.id,
      channel: IPC.OPS_INSTALL_RUNTIME,
      payload,
      progressKey: `progress:runtime:${game.id}`,
    });

    // Conflict confirmation loop
    if (result && result.code === 'needs-conflict-confirmation') {
      const choice = await window.UI.dialogs.showConflicts(result.conflicts || [],
        `Before installing runtime ${selectedVersion} into ${game.name}:`);
      if (choice !== 'continue') {
        window.UI.toast.info('Cancelled', 'Nothing was modified.');
        return;
      }
      payload = { ...payload, skipConflictWarnings: true };
      result = await runInstallWithDialog({
        title: `Installing runtime ${selectedVersion}`,
        intro: [el('strong', game.name), ` → DLSS runtime ${selectedVersion}`, ' (conflicts acknowledged)'],
        gameId: game.id,
        channel: IPC.OPS_INSTALL_RUNTIME,
        payload,
        progressKey: `progress:runtime:${game.id}`,
      });
    }

    if (result && result.ok) {
      window.UI.toast.success('Installation verified',
        `${game.name}: ${result.fromVersion || 'unknown'} → ${result.toVersion}${result.backupId ? ` (backup ${result.backupId})` : ''}`);
      window.UI.state.analysisCache[game.id] = null;
      rerender(ctx);
    } else if (result && result.rolledBack) {
      await window.UI.dialogs.showError('Installation failed — rolled back',
        'The installation could not be verified and was rolled back automatically. Your original files have been restored.',
        { detail: result.error, stack: result.stack, hint: 'Check the log (Options → Logging → Open log folder) and try a different runtime package. Re-import the package if it may be corrupted.' });
      rerender(ctx);
    } else if (result) {
      const hints = {
        'game-not-found': 'Re-scan your library.',
        'install-missing': 'The game folder moved or was uninstalled — remove the entry or re-scan.',
        'analysis-failed': 'Use Advanced Mode to pick the executable manually.',
        'game-running': 'Close the game, then try again.',
        'missing-package': 'Import or download this runtime version on the Runtimes page first.',
        'invalid-package': 'The stored package failed verification — delete and re-import it on the Runtimes page.',
        'backup-failed': 'A file could not be backed up (it may be in use). Close the game and retry.',
      };
      await window.UI.dialogs.showError('Installation failed', result.error || 'Unknown error', {
        detail: result.code ? `code: ${result.code}` : undefined,
        stack: result.stack,
        hint: hints[result.code] || 'Nothing was modified, or changes were rolled back.',
      });
      rerender(ctx);
    }
  }

  async function handleRestore(game, ctx) {
    const backups = await api.invoke(IPC.BACKUPS_LIST, { gameId: game.id });
    const usable = (backups || []).filter((b) => !b.corrupt);
    if (!usable.length) {
      await window.UI.dialogs.alert('No backups found',
        `${game.name} has no backups yet. A backup is created automatically the first time this app modifies the game.`);
      return;
    }

    // Choose which backup to restore
    let chosen = usable[0];
    if (usable.length > 1) {
      const select = el('select', {
        style: 'width:100%',
        onchange: (e) => { chosen = usable.find((b) => b.backupId === e.target.value) || chosen; showPreview(); },
      }, usable.map((b) => el('option', { value: b.backupId, selected: b.backupId === chosen.backupId || undefined },
        `${formatDateTimeShort(b.created)} — ${b.operation.type || 'operation'}${b.operation.version ? ` (${b.operation.version})` : ''} — ${b.backupId}`)));
      const previewHost = el('div');
      const showPreview = async () => {
        clear(previewHost);
        previewHost.appendChild(el('div.page-loading', 'Loading file list…'));
        const dry = await api.invoke(IPC.BACKUPS_RESTORE, { gameId: game.id, backupId: chosen.backupId, dryRun: true });
        clear(previewHost);
        if (dry && dry.ok) {
          previewHost.appendChild(el('div.file-list', [
            ...(dry.restored || []).map((f) => el('div.file-row', [el('span.file-kind', '↩'), f.relPath])),
            ...(dry.deleted || []).map((f) => el('div.file-row', [el('span.file-kind', '🗑'), `${f.relPath} (added by the app — will be removed)`])),
          ]));
          if ((dry.restored || []).length + (dry.deleted || []).length === 0) {
            previewHost.appendChild(el('p', 'This backup recorded no file changes.'));
          }
        } else {
          previewHost.appendChild(el('div.error-detail', (dry && dry.error) || 'Could not preview this backup.'));
        }
      };
      const body = [
        el('p', 'Choose which backup to restore. The files below will be returned to their original state:'),
        el('div', { style: 'margin-bottom:10px' }, select),
        previewHost,
        el('p', { style: 'margin-top:10px' }, [
          el('strong', 'Note: '),
          'files changed after the backup keep their backup copy; files this app added are removed only if they are still unmodified.',
        ]),
      ];
      const ok = await window.UI.dialogs.open({
        icon: '↩️',
        title: 'Restore original files',
        wide: true,
        body,
        buttons: [
          { label: 'Cancel', value: false },
          { label: 'Restore', value: true, kind: 'primary', autofocus: true },
        ],
      });
      if (!ok) return;
    } else {
      const dry = await api.invoke(IPC.BACKUPS_RESTORE, { gameId: game.id, backupId: chosen.backupId, dryRun: true });
      const body = [
        el('p', ['Restore the backup from ', el('strong', formatDateTimeShort(chosen.created)), ` (${chosen.operation.type || 'operation'}${chosen.operation.version ? ` ${chosen.operation.version}` : ''})?`]),
        dry && dry.ok ? el('div.file-list', [
          ...(dry.restored || []).map((f) => el('div.file-row', [el('span.file-kind', '↩'), f.relPath])),
          ...(dry.deleted || []).map((f) => el('div.file-row', [el('span.file-kind', '🗑'), `${f.relPath} (added by the app — will be removed)`])),
        ]) : el('div.error-detail', (dry && (dry.error || (dry.errors || []).join('; '))) || 'Backup preview unavailable — it will still be validated before restoring.'),
      ];
      const ok = await window.UI.dialogs.confirm('Restore original files?', body, { okLabel: 'Restore', icon: '↩️' });
      if (!ok) return;
    }

    const result = await runInstallWithDialog({
      title: 'Restoring original files',
      intro: [el('strong', game.name), ` — restoring backup ${chosen.backupId}`],
      gameId: game.id,
      channel: IPC.BACKUPS_RESTORE,
      payload: { gameId: game.id, backupId: chosen.backupId },
      progressKey: `progress:restore:${game.id}`,
    });
    if (result && result.ok) {
      window.UI.toast.success('Restore complete',
        `${(result.restored || []).length} file(s) restored, ${(result.deleted || []).length} removed.` +
        ((result.warnings || []).length ? ` ${result.warnings.length} warning(s) — see History.` : ''));
      window.UI.state.analysisCache[game.id] = null;
      rerender(ctx);
    } else {
      await window.UI.dialogs.showError('Restore failed', (result && (result.error || (result.errors || []).join('; '))) || 'Unknown error',
        { hint: 'The backup itself may be damaged — open the Backups page to inspect it.', stack: result && result.stack });
    }
  }

  function versionSelect(runtimes, currentVersion, onPick) {
    const select = el('select.select-version', {
      'aria-label': 'DLSS Runtime Version',
      onchange: (e) => { selectedVersion = e.target.value; onPick(selectedVersion); },
    });
    const placeholder = el('option', { value: '', disabled: true, selected: !selectedVersion || undefined }, 'Select a version…');
    select.appendChild(placeholder);
    for (const rt of runtimes.slice().reverse()) {
      const avail = rt.available ? (rt.complete ? '' : ' (incomplete)') : ' (not in library)';
      const opt = el('option', { value: rt.version, selected: selectedVersion === rt.version || undefined },
        `${rt.version}${avail}`);
      opt.disabled = !rt.complete;
      select.appendChild(opt);
    }
    if (selectedVersion && !runtimes.some((r) => r.version === selectedVersion)) selectedVersion = null;
    return select;
  }

  let rerenderFn = null;
  function rerender(ctx) {
    if (rerenderFn) rerenderFn(ctx);
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.gameDetail = {
    title: (ctx) => {
      const g = ctx.state.games.find((x) => x.id === decodeGameId(ctx.params[0]));
      return g ? g.name : 'Game';
    },
    render: async (container, ctx) => {
      const gameId = decodeGameId(ctx.params[0]);
      const game = ctx.state.games.find((g) => g.id === gameId);
      if (!game) {
        container.appendChild(el('div.empty-state', [
          el('div.empty-icon', '🕳️'),
          el('h3', 'Game not found'),
          el('p', 'It may have been removed. Re-scan your library.'),
          btn('← Back to Games', { kind: 'primary', onclick: () => window.UI.navigate('#/games') }),
        ]));
        return;
      }

      const analysisHost = el('div');
      const switchHost = el('div');
      const conflictHost = el('div');
      const backupHost = el('div');
      const injectionHost = el('div');

      container.appendChild(el('div.two-col', [
        el('div', [analysisHost, switchHost, injectionHost]),
        el('div', [conflictHost, backupHost]),
      ]));

      rerenderFn = async () => {
        clear(analysisHost); clear(switchHost); clear(conflictHost); clear(backupHost); clear(injectionHost);
        await renderAll();
      };

      async function renderAll() {
        // ---------------- Analysis ----------------
        analysisHost.appendChild(el('div.card', [
          el('h2.card-title', ['🔎 Game analysis', el('span.spacer'),
            btn('⟳ Re-analyze', { size: 'sm', onclick: async () => { window.UI.state.analysisCache[game.id] = null; rerender(ctx); } }),
          ]),
          el('div.page-loading', 'Analyzing installation…'),
        ]));
        const analysisCard = analysisHost.firstChild;

        const [analysis, runtimesRes, backups] = await Promise.all([
          ctx.analysisFor(game.id, { refresh: true }),
          ctx.state.runtimes || ctx.loadRuntimes(),
          api.invoke(IPC.BACKUPS_LIST, { gameId: game.id }),
        ]);
        const runtimes = (runtimesRes && runtimesRes.runtimes) || [];

        clear(analysisCard);
        analysisCard.appendChild(el('h2.card-title', ['🔎 Game analysis', el('span.spacer'),
          btn('⟳ Re-analyze', { size: 'sm', onclick: async () => { window.UI.state.analysisCache[game.id] = null; rerender(ctx); } })]));

        if (!analysis || analysis.ok === false) {
          analysisCard.appendChild(el('div.banner.banner-warning', [
            el('div', '⚠️'),
            el('div.banner-body', [
              el('strong', 'Analysis incomplete'),
              el('div', (analysis && (analysis.errors || []).join(' ') ) || analysis && analysis.error || 'Could not analyze this installation.'),
            ]),
          ]));
          if (ctx.state.settings && ctx.state.settings.advancedMode && analysis && analysis.executableCandidates && analysis.executableCandidates.length) {
            analysisCard.appendChild(el('div', { style: 'margin-top:8px' }, [
              el('div.field-label', 'Choose the game executable manually:'),
              el('select', {
                style: 'width:100%; margin-top:6px',
                onchange: async (e) => {
                  await api.invoke(IPC.GAMES_CHOOSE_EXE, { gameId: game.id, exePath: e.target.value });
                  window.UI.state.analysisCache[game.id] = null;
                  rerender(ctx);
                },
              }, analysis.executableCandidates.map((c) => el('option', { value: c }, c))),
            ]));
          }
        }

        const dlssValue = analysis && analysis.dlss && analysis.dlss.detected
          ? el('span', [
              badge('✓ Detected', 'success'),
              ` ${analysis.dlss.primaryVersion || 'version unknown'}`,
              analysis.dlss.versionSource ? el('span', { style: 'color:var(--text-faint); font-size:11.5px' }, ` (${analysis.dlss.versionSource})`) : null,
            ])
          : el('span.value.bad', '✕ Not detected');

        analysisCard.appendChild(el('div.status-list', [
          statusRow('Game', game.name),
          statusRow('Executable', analysis && analysis.executable ? `${analysis.executable.name}${analysis.is64bit === false ? ' (32-bit)' : ''}` : 'not found'),
          statusRow('Install folder', el('span.mono', game.installDir)),
          statusRow('Graphics API', analysis && analysis.graphicsApi && analysis.graphicsApi.length
            ? el('span', analysis.graphicsApi.map((a, i) => el('span', [i ? ', ' : null, a.api, a.uncertain ? ' (?)' : ''])))
            : 'unknown'),
          statusRow('DLSS', dlssValue),
          statusRow('Streamline', analysis && analysis.streamline && analysis.streamline.detected
            ? el('span', [badge('✓ Detected', 'success'), ` ${analysis.streamline.version || ''}`])
            : el('span.value.bad', '✕ Not detected'),
            'Streamline plugins (sl.*.dll) next to the executable'),
          statusRow('DLSS 5 Injection', analysis && analysis.injection && analysis.injection.installed
            ? el('span', [badge('✓ Installed', 'success'), ` ${analysis.injection.injectionName || ''}${analysis.injection.method ? ` · ${analysis.injection.method}` : ''}`])
            : 'Not installed'),
        ]));

        if (ctx.state.settings && ctx.state.settings.showAdvancedInfo && analysis) {
          analysisCard.appendChild(el('details', { style: 'margin-top:10px' }, [
            el('summary', { style: 'cursor:pointer; font-size:12.5px; color:var(--text-secondary)' }, 'Advanced: detected files'),
            el('div.table-wrap', { style: 'margin-top:8px' }, [
              el('table.data-table', [
                el('thead', el('tr', [el('th', 'File'), el('th', 'Version'), el('th', 'Size'), el('th', 'SHA-256')])),
                el('tbody', [...(analysis.dlss.files || []), ...(analysis.streamline.files || [])].map((f) =>
                  el('tr', [
                    el('td.mono', f.name),
                    el('td.mono', f.detectedVersion || '—'),
                    el('td', formatBytes(f.sizeBytes)),
                    el('td.mono', f.sha256 ? f.sha256.slice(0, 16) + '…' : '—'),
                  ])
                )),
              ]),
            ]),
          ]));
        }

        // ---------------- Version switching ----------------
        const currentVersion = analysis && analysis.dlss ? analysis.dlss.primaryVersion : null;
        if (!selectedVersion) {
          const latestComplete = runtimes.filter((r) => r.complete).pop();
          selectedVersion = latestComplete ? latestComplete.version : null;
        }
        const applyBtn = btn('⚡ Apply version', {
          kind: 'primary', size: 'lg',
          onclick: () => handleInstall(game, ctx),
          disabled: !selectedVersion,
        });
        const select = versionSelect(runtimes, currentVersion, () => { applyBtn.disabled = !selectedVersion; });

        const anyComplete = runtimes.some((r) => r.complete);
        switchHost.appendChild(el('div.card', [
          el('h2.card-title', '🔁 DLSS Runtime Version'),
          el('div.status-list', [
            statusRow('Current Version', currentVersion
              ? el('span.mono', currentVersion)
              : el('span', [el('span.value.warn', 'none detected'), ' — files will be added fresh'])),
            el('div.status-row', [
              el('span.label', 'Selected Version'),
              el('span.value', select),
            ]),
          ]),
          !anyComplete ? el('div.banner.banner-warning', { style: 'margin-top:10px' }, [
            el('div', '📦'),
            el('div.banner-body', [
              el('strong', 'No runtime packages in your library yet'),
              el('div', 'Import the runtime files you obtained from a legitimate source, or try a provider download — Runtimes page.'),
            ]),
          ]) : null,
          el('div.btn-row', { style: 'margin-top:12px' }, [
            applyBtn,
            btn('↩ Restore Original Files', {
              onclick: () => handleRestore(game, ctx),
              tip: 'Restore the game files from the most recent backup created by this app',
            }),
            btn('📂 Open folder', { kind: 'ghost', onclick: () => api.openPath(analysis && analysis.targetDir || game.installDir) }),
          ]),
        ]));

        // ---------------- Injection quick status ----------------
        const inj = analysis && analysis.injection;
        injectionHost.appendChild(el('div.card', [
          el('h2.card-title', '✨ DLSS 5 Neural Rendering'),
          el('div.status-list', [
            statusRow('Injection', inj && inj.installed
              ? el('span', [badge('✓ Installed', 'success'), ` ${inj.injectionName || ''} · ${inj.method || 'unknown method'}`])
              : 'Not installed'),
            statusRow('ReShade', analysis && analysis.reshade && analysis.reshade.installed ? badge('✓ Installed', 'success') : badge('Not installed', '')),
            statusRow('OptiScaler', analysis && analysis.optiscaler && analysis.optiscaler.detected ? badge('✓ Detected', 'success') : badge('Not detected', '')),
          ]),
          el('div.btn-row', { style: 'margin-top:12px' }, [
            btn('Open DLSS 5 Neural Rendering', { kind: 'primary', onclick: () => window.UI.navigate('#/dlss5') }),
          ]),
        ]));

        // ---------------- Conflicts ----------------
        const conflicts = await api.invoke(IPC.OPS_CHECK_CONFLICTS, { gameId: game.id });
        const list = (conflicts && conflicts.conflicts) || [];
        conflictHost.appendChild(el('div.card', [
          el('h2.card-title', ['🧩 Conflicts & environment', el('span.spacer'),
            btn('⟳', { size: 'sm', kind: 'ghost', onclick: () => rerender(ctx), ariaLabel: 'Refresh conflicts' })]),
          list.length === 0
            ? el('p', { style: 'color:var(--text-secondary); font-size:13px' }, 'No proxy DLLs or modding tools detected next to the executable.')
            : el('div.status-list', list.map((c) =>
                el('div.status-row', [
                  el('span.label', el('span', [
                    window.UI.badge(c.severity === 'warning' ? '⚠ warning' : c.severity === 'blocking' ? '⛔ blocking' : 'ℹ info',
                      c.severity === 'warning' ? 'warning' : c.severity === 'blocking' ? 'danger' : 'info'),
                  ])),
                  el('span.value', el('span', { style: 'font-weight:400' }, c.message)),
                ])
              )),
        ]));

        // ---------------- Backups ----------------
        const rows = (backups || []).slice(0, 6);
        backupHost.appendChild(el('div.card', [
          el('h2.card-title', ['🗄 Backups for this game', el('span.spacer'),
            btn('View all', { size: 'sm', kind: 'ghost', onclick: () => window.UI.navigate('#/backups') })]),
          rows.length === 0
            ? el('p', { style: 'color:var(--text-secondary); font-size:13px' }, 'No backups yet — one is created automatically before the first modification.')
            : el('div.status-list', rows.map((b) =>
                el('div.status-row', [
                  el('span.label', el('span', [
                    el('span.mono', b.backupId),
                    b.result === 'success' ? null : b.result === 'rolled-back' ? badge('rolled back', 'warning') : b.result === 'pending' ? badge('pending', '') : null,
                  ])),
                  el('span.value', el('span', { style: 'font-weight:400' },
                    `${formatDateTimeShort(b.created)} — ${b.operation.type || ''}${b.operation.version ? ` ${b.operation.version}` : ''} — ${(b.modifiedFiles || []).length} file(s)`)),
                ])
              )),
        ]));
      }

      await renderAll();
    },
    destroy: () => {
      for (const off of unsubs) off();
      unsubs = [];
      rerenderFn = null;
    },
  };

  // Expose for reuse by other pages
  window.UI.runInstallWithDialog = runInstallWithDialog;
  void compareVersions;
})();
