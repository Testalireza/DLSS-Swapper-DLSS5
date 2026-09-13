'use strict';

/**
 * History page — installation timeline (spec §16).
 */
(function () {
  const { el, clear, badge, btn } = window.UI;
  const { IPC } = window.DLSS5Shared;
  const { formatDateTime, formatDateTimeShort } = window.DLSS5Shared;
  const api = window.UI.api;

  let rerenderFn = null;

  function actionLabel(e) {
    switch (e.action) {
      case 'runtime-install': return `DLSS runtime ${e.fromVersion ? `${e.fromVersion} → ` : ''}${e.toVersion}`;
      case 'injection-install': return `DLSS 5 injection installed (${e.method || '?'})${e.injectionName ? ` — ${e.injectionName}` : ''}`;
      case 'injection-uninstall': return `DLSS 5 injection removed (${e.method || '?'})`;
      case 'restore': return 'Original files restored';
      default: return e.action || 'operation';
    }
  }

  function resultBadge(e) {
    switch (e.result) {
      case 'success': return badge('✓ Successful', 'success');
      case 'rolled-back': return badge('Rolled back', 'warning');
      case 'failed': return badge('✕ Failed', 'danger');
      case 'cancelled': return badge('Cancelled', '');
      default: return badge(e.result || '?', '');
    }
  }

  async function showEntryDetails(ctx, e) {
    const full = (await api.invoke(IPC.HISTORY_GET, { id: e.id })) || e;
    const stepsList = full.steps && full.steps.length
      ? el('div.step-list', full.steps.map((s) => el(`div.step-item.${s.status}`, [
          el('span.step-icon', s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '○'),
          el('span', s.label || s.id),
        ])))
      : null;
    await window.UI.dialogs.open({
      icon: '🕘',
      title: actionLabel(full),
      wide: true,
      body: [
        el('dl.kv-grid', [
          el('dt', 'Game'), el('dd', full.gameName || full.gameId),
          el('dt', 'When'), el('dd', formatDateTime(full.ts)),
          el('dt', 'Result'), el('dd', resultBadge(full)),
          full.backupId ? el('dt', 'Backup') : null,
          full.backupId ? el('dd.mono', full.backupId) : null,
          full.method ? el('dt', 'Method') : null,
          full.method ? el('dd', full.method) : null,
        ]),
        stepsList,
        full.details ? el('details', { style: 'margin-top:10px' }, [
          el('summary', { style: 'cursor:pointer; font-size:12.5px' }, 'Technical details'),
          el('div.log-view', { style: 'margin-top:6px' }, JSON.stringify(full.details, null, 2)),
        ]) : null,
      ],
      buttons: [
        { label: 'Close', value: 'close' },
        full.backupId
          ? { label: '↩ Restore associated backup', value: 'restore', kind: 'primary' }
          : null,
      ].filter(Boolean),
    }).then(async (choice) => {
      if (choice === 'restore') {
        const ok = await window.UI.dialogs.confirm('Restore associated backup?',
          `This restores the files recorded in backup ${full.backupId} for ${full.gameName}.`,
          { okLabel: 'Restore', icon: '↩️' });
        if (!ok) return;
        const res = await window.UI.runInstallWithDialog({
          title: 'Restoring backup',
          intro: [el('strong', full.gameName), ` — ${full.backupId}`],
          gameId: full.gameId,
          channel: IPC.BACKUPS_RESTORE,
          payload: { gameId: full.gameId, backupId: full.backupId },
          progressKey: `progress:restore:${full.gameId}`,
        });
        if (res && res.ok) window.UI.toast.success('Restore complete', `${(res.restored || []).length} file(s) restored.`);
        else await window.UI.dialogs.showError('Restore failed', (res && (res.error || (res.errors || []).join('; '))) || 'Unknown error');
        rerenderFn && rerenderFn(ctx);
      }
    });
  }

  window.UI.pages = window.UI.pages || {};
  window.UI.pages.history = {
    title: 'Installation History',
    subtitle: () => 'Every runtime swap, injection and restore, newest first',
    topbar: (ctx) => [
      btn('📄 Open logs', { onclick: () => api.openFolderVia(IPC.LOGS_OPEN_FOLDER) }),
      btn('⟳ Refresh', { onclick: () => rerenderFn && rerenderFn(ctx) }),
    ],
    render: async (container, ctx) => {
      rerenderFn = async () => { clear(container); await renderAll(); };
      async function renderAll() {
        const entries = (await api.invoke(IPC.HISTORY_LIST, { limit: 200 })) || [];
        if (!entries.length) {
          container.appendChild(el('div.card', el('div.empty-state', [
            el('div.empty-icon', '🕘'),
            el('h3', 'Nothing has happened yet'),
            el('p', 'Runtime installations, DLSS 5 injections and restores are recorded here with their backups, so you can always see — and undo — what changed.'),
            btn('Go to Games', { kind: 'primary', onclick: () => window.UI.navigate('#/games') }),
          ])));
          return;
        }

        const timeline = el('div.timeline');
        let lastDate = null;
        for (const e of entries) {
          const date = new Date(e.ts).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          if (date !== lastDate) {
            timeline.appendChild(el('div.timeline-date', date));
            lastDate = date;
          }
          timeline.appendChild(el('div.timeline-entry', [
            el('div.entry-main', [
              el('div.entry-title', [e.gameName || e.gameId, ' — ', actionLabel(e)]),
              el('div.entry-sub', [
                formatDateTimeShort(e.ts),
                e.method ? ` · ${e.method}` : '',
                e.backupId ? ` · backup ${e.backupId}` : '',
                e.result === 'rolled-back' && e.details && e.details.error ? ` · ${e.details.error}` : '',
              ]),
            ]),
            el('div.entry-actions', [
              resultBadge(e),
              btn('Details', { size: 'sm', onclick: () => showEntryDetails(ctx, e) }),
              e.backupId ? btn('↩ Restore', {
                size: 'sm', kind: 'ghost', tip: 'Restore the backup recorded by this operation',
                onclick: async () => {
                  const ok = await window.UI.dialogs.confirm('Restore associated backup?',
                    `Restore the files recorded in backup ${e.backupId} for ${e.gameName}?`, { okLabel: 'Restore', icon: '↩️' });
                  if (!ok) return;
                  const res = await window.UI.runInstallWithDialog({
                    title: 'Restoring backup', intro: [el('strong', e.gameName)], gameId: e.gameId,
                    channel: IPC.BACKUPS_RESTORE,
                    payload: { gameId: e.gameId, backupId: e.backupId },
                    progressKey: `progress:restore:${e.gameId}`,
                  });
                  if (res && res.ok) window.UI.toast.success('Restore complete', `${(res.restored || []).length} file(s) restored.`);
                  else await window.UI.dialogs.showError('Restore failed', (res && (res.error || (res.errors || []).join('; '))) || 'Unknown error');
                  rerenderFn(ctx);
                },
              }) : null,
            ]),
          ]));
        }
        container.appendChild(el('div.card', [el('h2.card-title', `🕘 ${entries.length} recorded operation(s)`), timeline]));
      }
      await renderAll();
    },
    destroy: () => { rerenderFn = null; },
  };
})();
