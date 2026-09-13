'use strict';

/**
 * Modal dialog system.
 *
 * - confirm(): promise-based, Esc/backdrop close = cancel, focus trap,
 *   supports arbitrary body content (file lists, warnings, forms).
 * - showError(): friendly explanation; stack traces only when Advanced Mode
 *   is on (spec §17).
 * - showConflicts(): the spec's "View Details / Continue Anyway / Cancel"
 *   three-way dialog.
 * - promptPath(): browser-mode replacement for native pickers.
 */
(function () {
  const { el, clear, btn } = window.UI;
  const root = () => document.getElementById('modal-root');
  const stack = [];

  function isAdvanced() {
    const s = window.UI.state && window.UI.state.settings;
    return !!(s && (s.advancedMode || s.showAdvancedInfo));
  }

  /**
   * Open a modal.
   * @param {object} opts
   * @param {string} [opts.icon] emoji/glyph shown at the left of the title
   * @param {string} opts.title
   * @param {Node|Node[]|string} [opts.body]
   * @param {Array<{label:string, kind?:string, value:*, autofocus?:boolean, disabled?:boolean, tip?:string}>} opts.buttons
   *        Resolves the promise with the clicked button's `value`; Esc/backdrop → null.
   * @param {boolean} [opts.wide]
   * @param {boolean} [opts.dismissable=true]
   */
  function open(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        const idx = stack.indexOf(backdrop);
        if (idx >= 0) stack.splice(idx, 1);
        // Restore focus
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* ignore */ } }
        resolve(value);
      };
      const lastFocus = document.activeElement;

      const buttons = (opts.buttons || [{ label: 'OK', value: true, kind: 'primary' }]).map((b) =>
        btn(b.label, {
          kind: b.kind || '',
          onclick: () => finish(b.value),
          disabled: b.disabled,
          tip: b.tip,
        })
      );

      const modal = el(`div.modal${opts.wide ? '.wide' : ''}`, {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': opts.title,
        onclick: (e) => e.stopPropagation(),
      }, [
        el('div.modal-header', [
          opts.icon ? el('div.modal-icon', { 'aria-hidden': 'true' }, opts.icon) : null,
          el('h2.modal-title', opts.title),
        ]),
        opts.body !== undefined && opts.body !== null ? el('div.modal-body', opts.body) : null,
        el('div.modal-footer', buttons),
      ]);

      const backdrop = el('div.modal-backdrop', {
        onclick: () => { if (opts.dismissable !== false) finish(null); },
      }, [modal]);

      const onKey = (e) => {
        if (stack[stack.length - 1] !== backdrop) return;
        if (e.key === 'Escape' && opts.dismissable !== false) {
          e.preventDefault();
          finish(null);
          return;
        }
        if (e.key === 'Tab') {
          // Simple focus trap
          const focusables = modal.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };

      root().appendChild(backdrop);
      stack.push(backdrop);
      document.addEventListener('keydown', onKey, true);

      const autofocus = (opts.buttons || []).findIndex((b) => b.autofocus);
      const target = autofocus >= 0 ? buttons[autofocus] : buttons[buttons.length - 1];
      setTimeout(() => target && target.focus(), 30);
    });
  }

  /** Yes/No confirm. Resolves true/false (null = dismissed → false). */
  async function confirm(title, body, opts = {}) {
    const r = await open({
      icon: opts.icon || '❔',
      title,
      body,
      buttons: [
        { label: opts.cancelLabel || 'Cancel', value: false },
        { label: opts.okLabel || 'Confirm', value: true, kind: opts.danger ? 'danger' : 'primary', autofocus: true },
      ],
    });
    return r === true;
  }

  /** Informational alert. */
  async function alert(title, body, opts = {}) {
    return open({ icon: opts.icon || 'ℹ️', title, body, buttons: [{ label: 'OK', value: true, kind: 'primary', autofocus: true }] });
  }

  /**
   * Error dialog: friendly explanation first; technical stack only in
   * Advanced Mode (spec §17).
   */
  async function showError(title, message, opts = {}) {
    const bodyNodes = [el('div', String(message || 'An unknown error occurred.'))];
    if (opts.detail) bodyNodes.push(el('div.error-detail', String(opts.detail)));
    if (opts.stack && isAdvanced()) bodyNodes.push(el('div.error-detail.stack', String(opts.stack)));
    if (opts.hint) bodyNodes.push(el('p', { style: 'margin-top:10px' }, [el('strong', 'What you can do: '), opts.hint]));
    return open({
      icon: '⚠️',
      title,
      body: bodyNodes,
      buttons: opts.buttons || [{ label: 'Close', value: true, kind: 'primary', autofocus: true }],
    });
  }

  /**
   * Conflict dialog (spec §15): View Details / Continue Anyway / Cancel.
   * Resolves 'continue' | 'cancel'.
   */
  async function showConflicts(conflicts, contextText) {
    const summarize = conflicts.filter((c) => c.severity === 'warning' || c.severity === 'blocking');
    const body = [
      el('div', contextText || 'The following potential conflicts were found in the game folder:'),
      el('div.file-list', summarize.map((c) =>
        el('div.file-row', [
          el('span.file-kind', c.severity === 'blocking' ? '⛔' : '⚠'),
          el('span', [
            el('strong', c.file || c.type),
            c.ownerLabel ? ` — appears to belong to ${c.ownerLabel}` : '',
            el('div', { style: 'font-family: var(--font-ui); color: var(--text-secondary)' }, c.message),
          ]),
        ])
      )),
      el('p', { style: 'margin:10px 0 0' }, 'Nothing will be deleted automatically. Backups are taken before any file is replaced.'),
    ];
    for (;;) {
      const result = await open({
        icon: '⚠️',
        title: 'Possible conflict detected',
        body,
        wide: true,
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'View Details', value: 'details' },
          { label: 'Continue Anyway', value: 'continue', kind: 'primary' },
        ],
      });
      if (result !== 'details') return result === 'continue' ? 'continue' : 'cancel';

      const detail = await open({
        icon: '🔍',
        title: 'Conflict details',
        wide: true,
        body: el('div.file-list', { style: 'max-height:400px' }, conflicts.map((c) =>
          el('div.file-row', { style: 'display:block; padding:6px 0; borderBottom:1px solid var(--divider)' }, [
            el('strong', `${c.file || c.type} `),
            window.UI.badge(c.severity, c.severity === 'warning' ? 'warning' : c.severity === 'blocking' ? 'danger' : 'info'),
            el('div', { style: 'font-family:var(--font-ui)' }, c.message),
            c.path ? el('div.mono', { style: 'color:var(--text-faint)' }, c.path) : null,
            c.sha256 && isAdvanced() ? el('div.mono', { style: 'color:var(--text-faint)' }, `sha256 ${c.sha256.slice(0, 24)}…`) : null,
          ])
        )),
        buttons: [
          { label: 'Back', value: 'back' },
          { label: 'Cancel', value: 'cancel' },
          { label: 'Continue Anyway', value: 'continue', kind: 'primary' },
        ],
      });
      if (detail === 'back') continue; // loop back to the summary dialog
      return detail === 'continue' ? 'continue' : 'cancel';
    }
  }

  /**
   * Path prompt — used in browser preview mode in place of native dialogs.
   */
  async function promptPath({ title, multiple = false }) {
    const input = multiple
      ? el('textarea', { placeholder: 'One absolute path per line', rows: 4 })
      : el('input', { type: 'text', placeholder: 'Absolute path, e.g. C:\\Games\\MyGame or /home/user/Games/MyGame', style: 'width:100%' });
    const result = await open({
      icon: '📁',
      title: title || (multiple ? 'Enter file paths' : 'Enter a folder path'),
      body: [
        el('p', 'Browser preview mode: native folder pickers are only available in the Windows app. Type the path(s) manually below.'),
        input,
      ],
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Use path', value: 'ok', kind: 'primary', autofocus: true },
      ],
    });
    if (result !== 'ok') return null;
    const raw = input.value.trim();
    if (!raw) return null;
    if (multiple) return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return raw;
  }

  /** Generic content dialog (returns whatever button value). */
  window.UI.dialogs = { open, confirm, alert, showError, showConflicts, promptPath, isAdvanced };

  // Register the browser-mode path prompter with the api bridge.
  if (window.UI.api && window.UI.api.setPathPrompter) {
    window.UI.api.setPathPrompter(promptPath);
  }
})();
