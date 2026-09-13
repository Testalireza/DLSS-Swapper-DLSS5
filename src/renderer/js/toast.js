'use strict';

/**
 * Toast notifications — non-blocking feedback, bottom-right stack.
 */
(function () {
  const { el } = window.UI;
  const DURATIONS = { info: 4200, success: 3600, warning: 6500, error: 9000 };

  function show(kind, title, message, opts = {}) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const node = el(`div.toast.${kind}`, {
      role: kind === 'error' ? 'alert' : 'status',
      onclick: () => dismiss(),
    }, [
      el('div.toast-msg', [
        title ? el('span.toast-title', title) : null,
        message ? el('span', message) : null,
      ]),
    ]);
    root.appendChild(node);
    let timer = setTimeout(dismiss, opts.duration || DURATIONS[kind] || 4500);
    function dismiss() {
      clearTimeout(timer);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 260);
    }
    // Cap the stack
    while (root.children.length > 5) root.firstChild.remove();
    return dismiss;
  }

  window.UI.toast = {
    info: (title, msg, opts) => show('info', title, msg, opts),
    success: (title, msg, opts) => show('success', title, msg, opts),
    warning: (title, msg, opts) => show('warning', title, msg, opts),
    error: (title, msg, opts) => show('error', title, msg, opts),
  };
})();
