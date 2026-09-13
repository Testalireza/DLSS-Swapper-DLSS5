'use strict';

/**
 * Backups page — history of every backup, validation, restore, delete and
 * "open location" (spec §6–§7).
 */
(function () {
  const { el, clear, badge, btn } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { formatDateTime, formatDateTimeShort, formatBytes } = window.DLSS5Shared;
  const api = window.UI.api;

  let rerenderFn = null;

  function operationLabel(b) {
    const op = b.operation || {};
    if (op.type === 'runtime-install') return `Runtime → ${op.version || '?'}`;
    if (op.type === 'injection-install') return `DLSS 5 injection (${op.method || '?'})${op.injectionName ? ` — ${op.injectionName}` : ''}`;
    return op.type || 'operation';
  }

  function resultBadge(b) {
    if (b.corrupt) return badge('corrupt metadata', 'danger');
    switch (b.result) {
      case 'success': return badge('✓ success', 'success');
      case 'rolled-back': return badge('rolled back', 'warning');
      case 'restored': return badge('restored', 'info');
      case 'pending': return badge('pending', '');
      case 'failed': return badge('failed', 'danger');
      default: return badge(b.result || 'unknown', '');
    }
  }

  async function showDetails(b) {
    const meta = await api.invoke(IPC.BACKUPS_GET, { gameId: b.game.id, backupId: b.backupId });
    if (meta && meta.ok === false) {
      await window.UI.dialogs.showError('Backup unreadable', meta.error);
      return;
    }
    const m = meta || b;
    await window.UI.dialogs.open({
      icon: '🗄',
      title: `Backup ${m.backupId}`,
      wide: true,
      body: [
        el('dl.kv-grid', [
          el('dt', 'Game'), el('dd', (m.game && m.game.name) || '?'),
          el('dt', 'Created'), el('dd', formatDateTime(m.created)),
          el('dt', 'Operation'), el('dd', operationLabel(m)),
          el('dt', 'Result'), el('dd', resultBadge(m)),
          m.runtimeBefore ? el('dt', 'Runtime before') : null,
          m.runtimeBefore ? el('dd.mono', `DLSS ${m.runtimeBefore.dlss || '?'} · Streamline ${m.runtimeBefore.streamline || '?'}`) : null,
          el('dt', 'App version'), el('dd', m.appVersion || '?'),
          el('dt', 'Backup folder'), el('dd.mono', m.__dir || ''),
        ]),
        el('h3', { style: 'margin:14px 0 6px; font-size:13px' }, `Preserved files (${(m.modifiedFiles || []).length})`),
        el('div.file-list', (m.modifiedFiles || []).map((f) =>
          el('div.file-row', [
            el('span.file-kind', '↩'),
            el('span', [el('strong', f.relPath), el('div.mono', { style: 'color:var(--text-faint)' }, `${formatBytes(f.sizeBytes)} · sha256 ${(f.originalHash || '').slice(0, 24)}…`)])]
        ))),
        (m.addedFiles || []).length ? el('h3', { style: 'margin:14px 0 6px; font-size:13px' }, `Files added by the operation (${m.addedFiles.length})`) : null,
        (m.addedFiles || []).length ? el('div.file-list', m.addedFiles.map((f) =>
          el('div.file-row', [el('span.file-kind', '🗑'), el('span', [el('strong', f.relPath), el('div', { style: 'color:var(--text-faint); font-size:11.5px' }, 'will be removed on restore (if unmodified)')])])
        )) : null,
      ],
      buttons: [{ label: 'Close', value: true, kind: 'primary' }],
    });
  }

  async function restoreBackup(ctx, b) {
    const dry = await api.invoke(IPC.BACKUPS_RESTORE, { gameId: b.game.id, backupId: b.backupId, dryRun: true });
    const ok = await window.UI.dialogs.open({
      icon: '↩️',
      title: 'Restore this backup?',
      wide: true,
      body: [
        el('div', [el('strong', b.game.name), ` — backup ${b.backupId} (${formatDateTime(b.created)})`]),
        dry && dry.ok
          ? el('div.file-list', [
              ...(dry.restored || []).map((f) => el('div.file-row', [el('span.file-kind', '↩'), `${f.relPath} — original content will be restored`])),
              ...(dry.deleted || []).map((f) => el('div.file-row', [el('span.file-kind', '🗑'), `${f.relPath} — added by the app, will be removed if unmodified`])),
              ...(dry.warnings || []).map((w) => el('div.file-row', [el('span.file-kind', '⚠'), w])),
            ])
          : el('div.error-detail', (dry && (dry.error || (dry.errors || []).join('; '))) || 'Backup could not be previewed — it will be validated before restoring.'),
        el('p', { style: 'margin-top:8px' }, 'The backup itself is hash-validated before anything is written. The game should be closed.'),
      ],
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Restore', value: true, kind: 'primary', autofocus: true },
      ],
    });
    if (!ok) return;
    const res = await window.UI.runInstallWithDialog({
      title: 'Restoring backup',
      intro: [el('strong', b.game.name), ` — ${b.backupId}`],
      gameId: b.game.id,
      channel: IPC.BACKUPS_RESTORE,
      payload: { gameId: b.game.id, backupId: b.backupId },
      progressKey: `progress:restore:${b.game.id}`,
    });
    if (res && res.ok) {
      window.UI.toast.success('Restore complete', `${(res.restored || []).length} file(s) restored, ${(res.deleted || []).length} removed, ${(res.warnings || []).length} warning(s).`);
      window.UI.state.analysisCache[b.game.id] = null;
      rerenderFn && rerenderFn(ctx);
    } else {
      await window.UI.dialogs.showError('Restore failed', (res && (res.error || (res.errors || []).join('; '))) || 'Unknown error', { stack: res && res.stack });
    }
  }

  async function deleteBackup(ctx, b) {
    const ok = await window.UI.dialogs.confirm('Delete this backup?', [
      el('div', [el('strong', b.game.name), ` — backup ${b.backupId}`]),
      el('p', 'This permanently removes the stored original files. You will not be able to restore this state afterwards.'),
    ], { okLabel: 'Delete backup', danger: true, icon: '🗑' });
    if (!ok) return;
    const res = await api.invoke(IPC.BACKUPS_DELETE, { gameId: b.game.id, backupId: b.backupId });
    if (res && res.ok) {
      window.UI.toast.info('Backup deleted', b.backupId);
      rerenderFn && rerenderFn(ctx);
    } else {
      await window.UI.dialogs.showError('Delete failed', (res && res.error) || 'Unknown error');
    }
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.backups = {
    title: 'Backups',
    subtitle: () => 'Every modification made by this app is backed up first',
    topbar: (ctx) => [
      btn('📂 Open backup location', { onclick: () => api.openFolderVia(IPC.BACKUPS_OPEN_FOLDER, {}) }),
      btn('⟳ Refresh', { onclick: () => rerenderFn && rerenderFn(ctx) }),
    ],
    render: async (container, ctx) => {
      rerenderFn = async () => { clear(container); await renderAll(); };
      async function renderAll() {
        const backups = (await api.invoke(IPC.BACKUPS_LIST, {})) || [];
        if (!backups.length) {
          container.appendChild(el('div.card', el('div.empty-state', [
            el('div.empty-icon', '🗄'),
            el('h3', 'No backups yet'),
            el('p', 'Backups appear here automatically the first time a runtime or injection is installed into one of your games. Each backup stores the original files, their hashes and full metadata — nothing is ever overwritten in place.'),
          ])));
          return;
        }

        // group by game
        const byGame = new Map();
        for (const b of backups) {
          const key = (b.game && b.game.name) || 'Unknown game';
          if (!byGame.has(key)) byGame.set(key, []);
          byGame.get(key).push(b);
        }

        for (const [gameName, list] of byGame) {
          const card = el('div.card', [
            el('h2.card-title', [`🎮 ${gameName}`, el('span.spacer'), badge(`${list.length} backup(s)`, '')]),
          ]);
          const table = el('div.table-wrap', el('table.data-table', [
            el('thead', el('tr', [
              el('th', 'Backup ID'), el('th', 'Created'), el('th', 'Operation'), el('th', 'Runtime before'),
              el('th', 'Files'), el('th', 'Result'), el('th', 'Actions'),
            ])),
            el('tbody', list.map((b) => el('tr', [
              el('td.mono', b.backupId),
              el('td', b.created ? formatDateTimeShort(b.created) : '?'),
              el('td', operationLabel(b)),
              el('td.mono', b.runtimeBefore ? `${b.runtimeBefore.dlss || '?'} / ${b.runtimeBefore.streamline || '—'}` : '—'),
              el('td', `${(b.modifiedFiles || []).length} preserved${(b.addedFiles || []).length ? `, ${b.addedFiles.length} added` : ''}`),
              el('td', resultBadge(b)),
              el('td', el('div.btn-row', [
                btn('Details', { size: 'sm', onclick: () => showDetails(b) }),
                btn('↩ Restore', { size: 'sm', kind: 'primary', disabled: !!b.corrupt, onclick: () => restoreBackup(ctx, b) }),
                btn('📂', { size: 'sm', kind: 'ghost', tip: 'Open backup folder', ariaLabel: 'Open backup folder', onclick: () => api.openFolderVia(IPC.BACKUPS_OPEN_FOLDER, { gameId: b.game.id, backupId: b.backupId }) }),
                btn('🗑', { size: 'sm', kind: 'ghost', tip: 'Delete backup', ariaLabel: 'Delete backup', onclick: () => deleteBackup(ctx, b) }),
              ])),
            ]))),
          ]));
          card.appendChild(table);
          container.appendChild(card);
        }
      }
      await renderAll();
    },
    destroy: () => { rerenderFn = null; },
  };
})();
