'use strict';

/**
 * Runtimes page — the version database (310.6.0 → 310.9.1), local package
 * library state, import and provider downloads (spec §3–§5, §20).
 */
(function () {
  const { el, clear, badge, btn, progressBar } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { formatBytes, formatDateTimeShort } = window.DLSS5Shared;
  const api = window.UI.api;

  let expanded = new Set();
  let rerenderFn = null;
  let dlUnsub = null;

  async function importDialog(ctx, version) {
    const files = await api.pickFiles(`Select the runtime files for ${version} (nvngx_dlss.dll required)`, ['dll', 'json']);
    if (!files || !files.length) return;
    const advanced = !!(ctx.state.settings && ctx.state.settings.advancedMode);
    let allowMismatch = false;
    if (advanced) {
      allowMismatch = await window.UI.dialogs.confirm('Version mismatch override?',
        'Advanced Mode: if the DLL version resource disagrees with the selected runtime version, the import will normally be rejected. Allow mismatched versions anyway?',
        { okLabel: 'Allow mismatches', cancelLabel: 'Strict validation' });
    }
    const res = await api.invoke(IPC.RUNTIMES_IMPORT, { version, filePaths: files, allowVersionMismatch: allowMismatch });
    if (res && res.ok) {
      window.UI.toast.success('Runtime imported', `${version}: ${res.package.files.length} file(s) validated and stored in your library.`);
      for (const w of res.warnings || []) window.UI.toast.warning('Import note', w);
      await ctx.loadRuntimes();
      rerenderFn && rerenderFn(ctx);
    } else if (res && !res.canceled) {
      await window.UI.dialogs.showError(`Import failed for ${version}`,
        (res.errors || []).join('\n') || res.error || 'Unknown error',
        {
          hint: 'The required file for this runtime is nvngx_dlss.dll. Optional Streamline files (sl.*.dll) are imported when present. Advanced Mode allows version-mismatch overrides.',
          stack: res.stack,
        });
    }
  }

  async function downloadFlow(ctx, version) {
    const progress = progressBar(null);
    const log = el('div.log-view', { style: 'max-height:160px' }, 'Starting download…');
    const append = (line) => { log.appendChild(el('div', line)); log.scrollTop = log.scrollHeight; };

    const off = window.UI.bus.on('downloadProgress', (d) => {
      if (d.version !== version) return;
      if (d.detail) append(d.detail);
      progress.set(typeof d.percent === 'number' ? d.percent : null);
    });

    // Live progress dialog while the providers work (Hide closes it early;
    // the download result is reported afterwards either way).
    const dialogP = window.UI.dialogs.open({
      icon: '🌐',
      title: `Downloading runtime ${version}`,
      body: [el('p', 'Trying configured providers…'), progress.node, log],
      buttons: [{ label: 'Hide', value: 'hide' }],
      dismissable: true,
    });

    let done;
    try {
      done = await api.invoke(IPC.RUNTIMES_DOWNLOAD, { version });
    } catch (err) {
      done = { ok: false, errors: [err.message] };
    } finally {
      off();
      const backdrops = document.querySelectorAll('#modal-root .modal-backdrop');
      const last = backdrops[backdrops.length - 1];
      const closeBtn = last && last.querySelector('.modal-footer .btn');
      if (closeBtn) closeBtn.click();
      await dialogP.catch(() => {});
    }

    if (done && done.ok) {
      window.UI.toast.success('Download complete', `Runtime ${version} is now in your library (via ${done.provider}).`);
      await ctx.loadRuntimes();
      rerenderFn && rerenderFn(ctx);
      return;
    }

    await window.UI.dialogs.open({
      icon: '🌐',
      title: `Automatic download failed for ${version}`,
      wide: true,
      body: [
        el('p', 'None of the configured sources provided this runtime. This is expected when no public mirror is configured or reachable.'),
        el('div.error-detail', (done && (done.errors || []).join('\n')) || 'Unknown error'),
        el('p', [el('strong', 'What you can do: '), 'obtain the runtime files from a legitimate source and use Import — the app validates filenames, structure and hashes, then adds the package to your local library.']),
        log,
      ],
      buttons: [
        { label: 'Close', value: false },
        { label: 'Import manually…', value: true, kind: 'primary' },
      ],
    }).then((pick) => { if (pick) importDialog(ctx, version); });
  }

  function versionRow(ctx, rt) {
    const r = rt.runtime;
    const isOpen = expanded.has(r.version);
    const statusBadge = rt.complete
      ? badge('✓ In library', 'success', `${rt.fileCount} file(s) · ${rt.origin || 'imported'}${rt.importedAt ? ' · ' + formatDateTimeShort(rt.importedAt) : ''}`)
      : rt.available
        ? badge(`Incomplete (missing ${rt.missing.join(', ')})`, 'warning')
        : badge('Not imported', '');

    const row = el('tr', [
      el('td', el('strong.mono', r.version)),
      el('td.mono', r.dlssVersion || '—'),
      el('td.mono', r.streamlineVersion || '—'),
      el('td', badge(r.channel || 'stable', r.channel === 'beta' ? 'warning' : '')),
      el('td', statusBadge),
      el('td', el('div.btn-row', [
        btn(isOpen ? '▾' : '▸', { size: 'sm', kind: 'ghost', ariaLabel: 'Toggle file list', onclick: () => { isOpen ? expanded.delete(r.version) : expanded.add(r.version); rerenderFn(ctx); } }),
        rt.complete
          ? btn('🗑', { size: 'sm', kind: 'ghost', tip: 'Delete the stored package', ariaLabel: 'Delete package', onclick: async () => {
              const ok = await window.UI.dialogs.confirm(`Delete runtime ${r.version}?`, 'The stored package files are removed from your library. Games already modified keep their files (restore from backups if needed).', { okLabel: 'Delete', danger: true });
              if (!ok) return;
              await api.invoke(IPC.RUNTIMES_DELETE, { version: r.version });
              window.UI.toast.info('Deleted', `Runtime ${r.version} removed from the library.`);
              await ctx.loadRuntimes();
              rerenderFn(ctx);
            } })
          : null,
        btn('⬇ Download', { size: 'sm', onclick: () => downloadFlow(ctx, r.version), tip: 'Try configured providers (GitHub releases, …)' }),
        btn('📥 Import', { size: 'sm', kind: 'primary', onclick: () => importDialog(ctx, r.version) }),
      ])),
    ]);

    const rows = [row];
    if (isOpen) {
      const pkgFiles = rt.package ? rt.package.files || [] : [];
      rows.push(el('tr', el('td', { colspan: 6, style: 'background:var(--surface-2)' }, [
        el('div', { style: 'padding:6px 4px' }, [
          r.notes ? el('div', { style: 'margin-bottom:8px; color:var(--text-secondary)' }, r.notes) : null,
          el('div.table-wrap', el('table.data-table', [
            el('thead', el('tr', [el('th', 'File'), el('th', 'Role'), el('th', 'Required'), el('th', 'Stored copy'), el('th', 'SHA-256'), el('th', 'Size')])),
            el('tbody', r.files.map((f) => {
              const stored = pkgFiles.find((p) => p.name === f.name);
              return el('tr', [
                el('td.mono', f.name),
                el('td', f.role),
                el('td', f.required ? 'yes' : 'optional'),
                el('td', stored ? badge('✓ stored', 'success', stored.detectedVersion ? `PE version: ${stored.detectedVersion}` : null) : '—'),
                el('td.mono', stored && stored.sha256 ? stored.sha256.slice(0, 20) + '…' : f.sha256 ? f.sha256.slice(0, 20) + '…' : 'recorded on import'),
                el('td', stored ? formatBytes(stored.sizeBytes) : '—'),
              ]);
            })),
          ])),
        ]),
      ])));
    }
    return rows;
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.runtimes = {
    title: 'DLSS Runtime Library',
    subtitle: () => 'Supported versions 310.6.0 → 310.9.1 · manifest-driven, expandable',
    topbar: (ctx) => [
      btn('📂 Open library folder', { onclick: () => api.openFolderVia(IPC.RUNTIMES_OPEN_LIBRARY) }),
      btn('⟳ Reload manifests', { onclick: async () => { await ctx.loadRuntimes(); window.UI.toast.info('Reloaded', 'Runtime manifest database re-read.'); rerenderFn(ctx); } }),
    ],
    render: async (container, ctx) => {
      rerenderFn = async () => { clear(container); await renderAll(); };
      async function renderAll() {
        const data = (await ctx.loadRuntimes()) || { runtimes: [], loadErrors: [], providers: [] };

        if (data.loadErrors && data.loadErrors.length) {
          container.appendChild(el('div.banner.banner-warning', [
            el('div', '⚠'),
            el('div.banner-body', [
              el('strong', 'Manifest problems detected'),
              el('div', data.loadErrors.map((e) => `${e.file}${e.version ? ` (${e.version})` : ''}: ${e.error}`).join('\n')),
            ]),
          ]));
        }

        const imported = data.runtimes.filter((r) => r.complete).length;
        container.appendChild(el('div.card', [
          el('h2.card-title', ['📚 Version database', el('span.spacer'),
            badge(`${imported}/${data.runtimes.length} in library`, imported === data.runtimes.length ? 'success' : '')]),
          el('p.section-note', 'Versions come from JSON manifests (resources/RuntimeManifests). Add a manifest + import a package and the new version appears everywhere — no code changes. Files are validated and hashed on import; nothing is installed blindly.'),
          el('div.table-wrap', el('table.data-table', [
            el('thead', el('tr', [
              el('th', 'Version'), el('th', 'DLSS'), el('th', 'Streamline'), el('th', 'Channel'), el('th', 'Library status'), el('th', 'Actions'),
            ])),
            el('tbody', data.runtimes.flatMap((rt) => versionRow(ctx, rt))),
          ])),
        ]));

        container.appendChild(el('div.card', [
          el('h2.card-title', '🌐 Runtime source providers'),
          el('p.section-note', 'The app never depends on a single website. Providers fill your local library; installation always reads from the validated local copy.'),
          el('div.status-list', (data.providers || []).map((p) =>
            el('div.status-row', [el('span.label', p.name), el('span.value', el('span', { style: 'font-weight:400' }, p.description))])
          )),
          el('div.btn-row', { style: 'margin-top:10px' }, [
            btn('Manage providers in Options', { onclick: () => window.UI.navigate('#/options') }),
          ]),
        ]));
      }
      await renderAll();
    },
    destroy: () => { rerenderFn = null; if (dlUnsub) { dlUnsub(); dlUnsub = null; } },
  };
})();
