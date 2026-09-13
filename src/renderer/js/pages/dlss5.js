'use strict';

/**
 * DLSS 5 Neural Rendering page (spec §9–§11):
 *  - GPU / RTX compatibility panel
 *  - Injection package library (import / delete / inspect)
 *  - Per-game installation with the two methods: OptiScaler & ReShade
 */
(function () {
  const { el, clear, badge, btn, statusRow, stepList } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { formatBytes, formatDateTimeShort } = window.DLSS5Shared;
  const api = window.UI.api;

  let chosenGameId = null;
  let chosenMethod = 'optiscaler';
  let rerenderFn = null;
  let gpuUnsub = null;

  // ------------------------------------------------------------- GPU panel

  function gpuPanel(ctx) {
    const card = el('div.card', [el('h2.card-title', ['🎮 NVIDIA GPU & compatibility', el('span.spacer'),
      btn('⟳ Refresh', { size: 'sm', onclick: async () => { await ctx.loadGpu(true); rerender(ctx); } })])]);
    const body = el('div');
    card.appendChild(body);

    const renderGpu = (info) => {
      clear(body);
      if (!info) { body.appendChild(el('div.page-loading', 'Detecting GPU…')); return; }
      const g = info.nvidia;
      const compat = info.compatibility || { status: 'unknown', headline: 'Compatibility could not be fully verified.', reasons: [], warnings: [] };
      const compatBadge = compat.status === 'supported'
        ? badge('✓ Supported', 'success')
        : compat.status === 'unsupported'
          ? badge('✕ Not supported', 'danger')
          : badge('⚠ Could not be fully verified', 'warning');

      body.appendChild(el('div.status-list', [
        statusRow('GPU', g ? g.name : el('span.value.warn', 'No NVIDIA GPU detected')),
        statusRow('Architecture', g ? `${g.architecture || 'unknown'}${g.series ? ` · ${g.series}` : ''}${g.confidence === 'medium' ? ' (name-based)' : ''}` : '—'),
        statusRow('Driver', g && g.driverVersion ? g.driverVersion : el('span.value.warn', 'unknown')),
        statusRow('VRAM', g && g.vramBytes ? `${formatBytes(g.vramBytes)}${g.vramApproximate ? ' (approx.)' : ''}` : '—'),
        statusRow('Compute capability', g && g.computeCapability != null ? String(g.computeCapability) : 'unknown'),
        statusRow('Compatibility', el('span', [compatBadge, ' ', compat.headline || ''])),
        statusRow('Target list', 'RTX 20 · RTX 30 · RTX 40 · RTX 50 series'),
        statusRow('Detected via', (info.detectedVia || []).join(', ') || 'nothing (browser preview without NVIDIA driver?)'),
      ]));

      if (compat.reasons && compat.reasons.length) {
        body.appendChild(el('div', { style: 'margin-top:10px; font-size:12.5px; color:var(--text-secondary)' },
          compat.reasons.map((r) => el('div', `· ${r}`))));
      }
      for (const w of compat.warnings || []) {
        body.appendChild(el('div.banner.banner-warning', { style: 'margin-top:10px' }, [el('div', '⚠'), el('div.banner-body', w)]));
      }
      if (compat.status !== 'supported') {
        const settings = ctx.state.settings || {};
        const overrideRow = el('div.field', { style: 'margin-top:6px' }, [
          el('div.field-info', [
            el('div.field-label', 'Override compatibility warning (Advanced)'),
            el('div.field-desc', 'Proceed with installation even though compatibility could not be verified. Only meaningful if you know your GPU is supported.'),
          ]),
          el('label.toggle', [
            el('input', {
              type: 'checkbox',
              checked: settings.gpuCompatibilityOverride || undefined,
              onchange: async (e) => {
                await api.invoke(IPC.SETTINGS_SET, { patch: { gpuCompatibilityOverride: e.target.checked } });
                await window.UI.reloadSettings();
              },
            }),
            el('span.track'), el('span.thumb'),
          ]),
        ]);
        if (settings.advancedMode || compat.canOverride) body.appendChild(overrideRow);
      }
    };

    renderGpu(ctx.state.gpu);
    if (gpuUnsub) gpuUnsub();
    gpuUnsub = ctx.bus.on('gpu:loaded', renderGpu);
    if (!ctx.state.gpu) ctx.loadGpu().then(renderGpu).catch(() => {});
    return card;
  }

  // --------------------------------------------------- injection library

  async function importInjectionDialog(ctx) {
    const advanced = !!(ctx.state.settings && ctx.state.settings.advancedMode);
    const paths = await api.pickFiles('Select DLSS 5 injection files (patched DLL / .addon64 / configs)', ['dll', 'addon64', 'addon32', 'ini', 'json']);
    if (!paths || !paths.length) return;

    const nameInput = el('input', { type: 'text', placeholder: 'e.g. DLSS5 Neural Rendering Patch', style: 'width:100%' });
    const descInput = el('input', { type: 'text', placeholder: 'Optional description / source', style: 'width:100%' });
    const methodOpti = el('input', { type: 'checkbox', checked: true });
    const methodRe = el('input', { type: 'checkbox', checked: true });
    const filesList = el('div.file-list', paths.map((p) => {
      const name = p.split(/[\\/]/).pop();
      return el('div.file-row', [el('span.file-kind', '📄'), el('span', [el('strong', name), el('span.mono', { style: 'color:var(--text-faint)' }, `  ${p}`)])]);
    }));

    const advancedHost = el('div');
    if (advanced) {
      advancedHost.appendChild(el('div', { style: 'margin-top:12px' }, [
        el('div.field-label', 'Per-file roles / renames (JSON)'),
        el('div.field-desc', 'Array of {name, role, installAs}. Roles: injection-core, injection-addon, proxy, config, other.'),
        el('textarea', { id: 'inj-overrides', rows: 4 }, JSON.stringify(paths.map((p) => ({ name: p.split(/[\\/]/).pop() })), null, 2)),
        el('div.field-label', { style: 'margin-top:10px' }, 'Config directives (JSON)'),
        el('div.field-desc', 'Array of {file, section, key, value, mode:"set-if-missing"|"ensure-csv"} applied to INI files in the game folder.'),
        el('textarea', { id: 'inj-directives', rows: 3 }, '[]'),
      ]));
    }

    const ok = await window.UI.dialogs.open({
      icon: '📥',
      title: 'Import DLSS 5 injection package',
      wide: true,
      body: [
        el('p', 'The app manages injection packages generically — nothing is hardcoded to one specific patched binary. Provide the files you legitimately obtained.'),
        el('div', { style: 'margin-bottom:10px' }, [el('label.field-label', 'Package name'), nameInput]),
        el('div', { style: 'margin-bottom:10px' }, [el('label.field-label', 'Description'), descInput]),
        el('div', { style: 'margin-bottom:10px' }, [
          el('label.field-label', 'Supported methods'),
          el('div', { style: 'display:flex; gap:16px; margin-top:4px' }, [
            el('label', { style: 'display:flex; gap:6px; align-items:center' }, [methodOpti, 'OptiScaler']),
            el('label', { style: 'display:flex; gap:6px; align-items:center' }, [methodRe, 'ReShade']),
          ]),
        ]),
        el('div.field-label', 'Files'),
        filesList,
        advancedHost,
      ],
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Import package', value: true, kind: 'primary', autofocus: true },
      ],
    });
    if (!ok) return;

    const methods = [];
    if (methodOpti.checked) methods.push('optiscaler');
    if (methodRe.checked) methods.push('reshade');

    let fileOverrides;
    let configDirectives;
    if (advanced) {
      try { fileOverrides = JSON.parse(document.getElementById('inj-overrides').value || '[]'); }
      catch (e) { await window.UI.dialogs.showError('Invalid overrides JSON', e.message); return; }
      try { configDirectives = JSON.parse(document.getElementById('inj-directives').value || '[]'); }
      catch (e) { await window.UI.dialogs.showError('Invalid directives JSON', e.message); return; }
    }

    const res = await api.invoke(IPC.INJECTIONS_IMPORT, {
      filePaths: paths,
      name: nameInput.value.trim() || undefined,
      description: descInput.value.trim() || undefined,
      methods: methods.length ? methods : undefined,
      fileOverrides,
      configDirectives,
    });
    if (res && res.ok) {
      window.UI.toast.success('Injection imported', `${res.package.name} added to the injection library.`);
      for (const w of res.warnings || []) window.UI.toast.warning('Import warning', w);
      rerender(ctx);
    } else if (res && !res.canceled) {
      await window.UI.dialogs.showError('Import failed', (res.errors || []).join('\n') || res.error || 'Unknown error',
        { hint: 'Make sure the selection contains at least one core file (DLL/add-on/proxy). Roles can be assigned manually in Advanced Mode.' });
    }
  }

  function injectionLibraryPanel(ctx, packages) {
    const card = el('div.card', [
      el('h2.card-title', ['🧪 Injection packages', el('span.spacer'),
        btn('📥 Import injection file(s)', { kind: 'primary', onclick: () => importInjectionDialog(ctx) })]),
    ]);
    if (!packages.length) {
      card.appendChild(el('div.empty-state', [
        el('div.empty-icon', '✨'),
        el('h3', 'No DLSS 5 injection packages yet'),
        el('p', 'Import the patched file(s) you obtained from a legitimate source. The app validates, hashes and stores them here — then installs them into games with a backup you can restore at any time.'),
      ]));
      return card;
    }
    for (const pkg of packages) {
      card.appendChild(el('div', { style: 'border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px; margin-top:10px' }, [
        el('div', { style: 'display:flex; gap:10px; alignItems:center' }, [
          el('strong', pkg.name),
          badge(pkg.methods && pkg.methods.includes('reshade') ? 'ReShade' : '', pkg.methods && pkg.methods.includes('reshade') ? 'info' : ''),
          badge(pkg.methods && pkg.methods.includes('optiscaler') ? 'OptiScaler' : '', pkg.methods && pkg.methods.includes('optiscaler') ? 'accent' : ''),
          el('span.spacer', { style: 'flex:1' }),
          el('span', { style: 'font-size:11.5px; color:var(--text-faint)' }, `imported ${formatDateTimeShort(pkg.importedAt)}`),
          btn('🗑', {
            size: 'sm', kind: 'ghost', tip: 'Delete this injection package from the library', ariaLabel: 'Delete package',
            onclick: async () => {
              const ok = await window.UI.dialogs.confirm('Delete injection package?', [
                el('div', [el('strong', pkg.name), ' will be removed from the injection library.']),
                el('p', 'Games where it is already installed keep their files; you can still restore them from backups.'),
              ], { okLabel: 'Delete', danger: true });
              if (!ok) return;
              await api.invoke(IPC.INJECTIONS_DELETE, { id: pkg.id });
              window.UI.toast.info('Deleted', `${pkg.name} removed from the injection library.`);
              rerender(ctx);
            },
          }),
        ]),
        pkg.description ? el('div', { style: 'font-size:12.5px; color:var(--text-secondary); margin-top:4px' }, pkg.description) : null,
        el('div.chip-list', { style: 'margin-top:8px' }, (pkg.files || []).map((f) =>
          el('span.chip', { 'data-tip': `role: ${f.role}${f.installAs && f.installAs !== f.name ? `\ninstalls as: ${f.installAs}` : ''}${f.detectedVersion ? `\nversion: ${f.detectedVersion}` : ''}\nsha256: ${f.sha256}` },
            `${f.name}${f.installAs && f.installAs !== f.name ? ` → ${f.installAs}` : ''}`)
        )),
      ]));
    }
    return card;
  }

  // ------------------------------------------------------ install section

  function installPanel(ctx, games, packages, statusInfo) {
    const card = el('div.card', [el('h2.card-title', '🚀 Install into a game')]);

    if (!games.length) {
      card.appendChild(el('p', 'No games in your library yet — add games first.'));
      return card;
    }
    if (!packages.length) {
      card.appendChild(el('p', { style: 'color:var(--text-secondary)' }, 'Import an injection package above first, then install it into a game here.'));
      return card;
    }

    // Game selector
    if (!chosenGameId || !games.some((g) => g.id === chosenGameId)) chosenGameId = games[0].id;
    const gameSelect = el('select', {
      style: 'min-width:260px',
      'aria-label': 'Choose a game',
      onchange: async (e) => { chosenGameId = e.target.value; rerender(ctx); },
    }, games.map((g) => el('option', { value: g.id, selected: g.id === chosenGameId || undefined }, g.name)));

    // Package selector
    let chosenPkgId = packages[0].id;
    const pkgSelect = el('select', {
      style: 'min-width:220px',
      'aria-label': 'Choose an injection package',
      onchange: (e) => { chosenPkgId = e.target.value; },
    }, packages.map((p) => el('option', { value: p.id }, p.name)));

    card.appendChild(el('div.btn-row', { style: 'margin-bottom:14px' }, [
      el('label', { style: 'font-size:12.5px; color:var(--text-secondary)' }, 'Game'), gameSelect,
      el('label', { style: 'font-size:12.5px; color:var(--text-secondary)' }, 'Package'), pkgSelect,
    ]));

    const status = statusInfo && statusInfo.methods ? statusInfo.methods : {};
    const opti = status.optiscaler || {};
    const reshade = status.reshade || {};

    const methodCards = el('div.method-cards', [
      methodCard('optiscaler', 'OptiScaler', opti, ctx),
      methodCard('reshade', 'ReShade', reshade, ctx),
    ]);
    card.appendChild(methodCards);

    const sel = status[chosenMethod] || {};
    const problems = sel.problems || [];
    const warnings = sel.warnings || [];
    for (const p of problems) {
      card.appendChild(el('div.banner.banner-warning', { style: 'margin-top:12px' }, [el('div', '⚠'), el('div.banner-body', p)]));
    }
    for (const w of warnings) {
      card.appendChild(el('div.banner.banner-info', { style: 'margin-top:8px' }, [el('div', 'ℹ'), el('div.banner-body', w)]));
    }

    const instructions = chosenMethod === 'reshade'
      ? 'ReShade workflow: ReShade must already be installed for the game (the app never installs ReShade itself). The injection add-on is placed next to the game executable and ReShade.ini is extended (append-only) so ReShade loads it. Your presets and shaders are never touched, and every modified file is backed up first.'
      : 'OptiScaler workflow: if OptiScaler is already installed, the injection files are added around it and its configuration is extended without overwriting your settings. If OptiScaler is absent, the imported package must carry the proxy files (nvngx.dll / dxgi.dll / winmm.dll) itself.';
    card.appendChild(el('p', { style: 'font-size:12.5px; color:var(--text-secondary); margin-top:12px' }, instructions));

    const pkg = packages.find((p) => p.id === chosenPkgId);
    const supportsMethod = pkg && (pkg.methods || []).includes(chosenMethod);

    card.appendChild(el('div.btn-row', { style: 'margin-top:14px' }, [
      sel.installed
        ? btn('🗑 Uninstall injection & restore files', {
            kind: 'danger',
            onclick: () => handleUninstall(ctx, sel),
          })
        : btn('⚡ Install DLSS 5 Injection', {
            kind: 'primary', size: 'lg',
            onclick: () => handleInstallInjection(ctx, chosenPkgId),
            tip: supportsMethod ? 'Backup → install → verify' : 'This package does not declare support for the selected method — Advanced force will be offered',
          }),
      sel.installed && sel.op && sel.op.backupId
        ? el('span', { style: 'font-size:12px; color:var(--text-faint)' }, `installed via backup ${sel.op.backupId}`)
        : null,
    ]));

    return card;
  }

  function methodCard(id, label, info, ctx) {
    const detected = info.detected;
    const selected = chosenMethod === id;
    const card = el('button.method-card', {
      class: selected ? 'selected' : '',
      onclick: () => { chosenMethod = id; rerender(ctx); },
      'aria-pressed': selected ? 'true' : 'false',
    }, [
      el('div.method-head', [el('span.method-radio'), label]),
      el('div.method-desc', id === 'optiscaler'
        ? 'Inject via an OptiScaler proxy (nvngx.dll). Works with DLSS-native games.'
        : 'Inject as a ReShade add-on (.addon64). Requires an existing ReShade install.'),
      el('div.method-status', [
        el('span', [id === 'optiscaler' ? 'OptiScaler: ' : 'ReShade: ',
          detected ? badge(`✓ ${info.version ? 'Detected ' + info.version : 'Detected'}`, 'success') : badge('Not detected', '')]),
        el('span', ['Injection: ',
          info.installed ? badge('✓ Installed', 'success') : badge('Not installed', '')]),
        id === 'reshade' && info.proxyDll ? el('span.mono', { style: 'font-size:11px; color:var(--text-faint)' }, `proxy: ${info.proxyDll}`) : null,
      ]),
    ]);
    return card;
  }

  async function handleInstallInjection(ctx, injectionId) {
    const settings = ctx.state.settings || {};
    const game = ctx.state.games.find((g) => g.id === chosenGameId);
    if (!game) return;

    // GPU gate
    const gpu = ctx.state.gpu || await ctx.loadGpu();
    const compat = gpu && gpu.compatibility;
    if (compat && compat.status !== 'supported' && !(settings.gpuCompatibilityOverride && settings.advancedMode)) {
      const proceed = await window.UI.dialogs.open({
        icon: '⚠️',
        title: 'GPU compatibility not verified',
        body: [
          el('div', compat.headline || 'Compatibility could not be fully verified.'),
          el('div.file-list', (compat.reasons || []).map((r) => el('div.file-row', r))),
          el('p', 'DLSS 5 Neural Rendering targets NVIDIA RTX 20/30/40/50 series GPUs. Installing on unverified hardware may not work and can cause crashes.'),
          el('p', [el('strong', 'Advanced Mode'), ' users can enable the compatibility override in the GPU panel to skip this warning.']),
        ],
        buttons: [
          { label: 'Cancel', value: false },
          { label: 'Install anyway (this once)', value: true, kind: 'primary' },
        ],
      });
      if (!proceed) return;
    }

    let payload = { gameId: game.id, injectionId, method: chosenMethod, force: false, skipConflictWarnings: false };
    let result = await window.UI.runInstallWithDialog({
      title: `Installing DLSS 5 injection (${chosenMethod})`,
      intro: [el('strong', game.name), ` — DLSS 5 Neural Rendering via ${chosenMethod === 'reshade' ? 'ReShade' : 'OptiScaler'}`],
      gameId: game.id,
      channel: IPC.INJECTIONS_INSTALL,
      payload,
      progressKey: `progress:injection:${game.id}`,
    });

    if (result && result.code === 'method-mismatch' && settings.advancedMode) {
      const okForce = await window.UI.dialogs.confirm('Force this method?', [
        el('div', result.error),
        el('p', 'Only continue if you know the package works with this method.'),
      ], { okLabel: 'Force install', danger: true });
      if (okForce) {
        result = await window.UI.runInstallWithDialog({
          title: `Installing DLSS 5 injection (${chosenMethod}, forced)`,
          intro: [el('strong', game.name)],
          gameId: game.id,
          channel: IPC.INJECTIONS_INSTALL,
          payload: { ...payload, force: true },
          progressKey: `progress:injection:${game.id}`,
        });
      }
    }

    if (result && result.code === 'needs-conflict-confirmation') {
      const choice = await window.UI.dialogs.showConflicts(result.conflicts || [], `Before installing into ${game.name}:`);
      if (choice !== 'continue') { window.UI.toast.info('Cancelled', 'Nothing was modified.'); return; }
      result = await window.UI.runInstallWithDialog({
        title: `Installing DLSS 5 injection (${chosenMethod})`,
        intro: [el('strong', game.name), ' (conflicts acknowledged)'],
        gameId: game.id,
        channel: IPC.INJECTIONS_INSTALL,
        payload: { ...payload, skipConflictWarnings: true },
        progressKey: `progress:injection:${game.id}`,
      });
    }

    if (result && result.ok) {
      window.UI.toast.success('DLSS 5 injection installed',
        `${game.name}: ${(result.installedFiles || []).join(', ')}${(result.iniEdits || []).some((e) => e.changed) ? ' · configuration updated' : ''}`);
      window.UI.state.analysisCache[game.id] = null;
      rerender(ctx);
    } else if (result && result.rolledBack) {
      await window.UI.dialogs.showError('Injection failed — rolled back',
        'The installation could not be verified and was rolled back automatically. Your original files were restored.',
        { detail: result.error, stack: result.stack });
      rerender(ctx);
    } else if (result && !result.ok) {
      await window.UI.dialogs.showError('Injection failed', result.error || 'Unknown error',
        { detail: result.code ? `code: ${result.code}` : undefined, stack: result.stack, hint: hintFor(result.code) });
    }
  }

  function hintFor(code) {
    return {
      'reshade-missing': 'Install ReShade (with add-on support) for this game first — see reshade.me. The app never installs ReShade for you.',
      'optiscaler-missing': 'Install OptiScaler for this game, or import an injection package that contains the OptiScaler proxy files.',
      'game-running': 'Close the game and try again.',
      'missing-package': 'The injection package was deleted — import it again.',
      'method-mismatch': 'Enable Advanced Mode to force a method the package does not declare.',
    }[code] || null;
  }

  async function handleUninstall(ctx, methodInfo) {
    const game = ctx.state.games.find((g) => g.id === chosenGameId);
    if (!game) return;
    const ok = await window.UI.dialogs.confirm('Uninstall DLSS 5 injection?', [
      el('div', [el('strong', game.name), ` — remove the ${chosenMethod === 'reshade' ? 'ReShade' : 'OptiScaler'} injection and restore the original files from backup ${methodInfo.op ? methodInfo.op.backupId : ''}?`]),
      el('p', 'Files this app added are removed; files it replaced are restored. Your own ReShade presets/shaders are not touched.'),
    ], { okLabel: 'Uninstall & restore', icon: '🗑', danger: true });
    if (!ok) return;
    const result = await window.UI.runInstallWithDialog({
      title: 'Uninstalling DLSS 5 injection',
      intro: [el('strong', game.name)],
      gameId: game.id,
      channel: IPC.INJECTIONS_UNINSTALL,
      payload: { gameId: game.id, method: chosenMethod },
      progressKey: `progress:injection-uninstall:${game.id}`,
    });
    if (result && result.ok) {
      window.UI.toast.success('Injection removed', 'Original files restored and verified.');
      window.UI.state.analysisCache[game.id] = null;
      rerender(ctx);
    } else {
      await window.UI.dialogs.showError('Uninstall failed', (result && (result.error || (result.errors || []).join('; '))) || 'Unknown error', { stack: result && result.stack });
    }
  }

  // ------------------------------------------------------------------ page

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.dlss5 = {
    title: 'DLSS 5 Neural Rendering',
    subtitle: () => 'Injection packages, GPU compatibility, OptiScaler & ReShade workflows',
    render: async (container, ctx) => {
      rerenderFn = async () => { clear(container); await renderAll(); };
      async function renderAll() {
        const [packages, games] = [
          await api.invoke(IPC.INJECTIONS_LIST),
          ctx.state.games.length ? ctx.state.games : await ctx.refreshGames(),
        ];
        let statusInfo = null;
        if (chosenGameId || games.length) {
          const gid = chosenGameId && games.some((g) => g.id === chosenGameId) ? chosenGameId : (games[0] && games[0].id);
          chosenGameId = gid;
          if (gid) statusInfo = await api.invoke(IPC.INJECTIONS_STATUS, { gameId: gid });
        }

        container.appendChild(el('div.two-col', [
          el('div', [
            gpuPanel(ctx),
            installPanel(ctx, games, packages || [], statusInfo),
          ]),
          el('div', [injectionLibraryPanel(ctx, packages || [])]),
        ]));
      }
      await renderAll();
    },
    destroy: () => { rerenderFn = null; if (gpuUnsub) { gpuUnsub(); gpuUnsub = null; } },
  };

  function rerender(ctx) { if (rerenderFn) rerenderFn(ctx); }
  void stepList;
})();
