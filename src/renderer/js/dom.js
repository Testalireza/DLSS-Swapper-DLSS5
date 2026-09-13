'use strict';

/**
 * Tiny DOM helpers — hyperscript style, no framework.
 * Everything in the renderer builds UI through these so pages stay compact
 * and consistent (and testable under jsdom).
 */
(function () {
  /**
   * el('div.card', { onclick, data-tip, ...}, [children])
   * Tag syntax: 'tag.class1.class2#id'
   */
  function el(spec, props, children) {
    let tag = 'div';
    let id = null;
    const classes = [];
    const m = String(spec).match(/^([a-zA-Z0-9-]+)?((?:[.#][^.#]+)*)$/);
    if (m) {
      if (m[1]) tag = m[1];
      for (const part of (m[2] || '').split(/(?=[.#])/).filter(Boolean)) {
        if (part[0] === '.') classes.push(part.slice(1));
        else id = part.slice(1);
      }
    } else {
      tag = String(spec);
    }
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(' ');
    if (props && (Array.isArray(props) || typeof props !== 'object' || props instanceof Node)) {
      children = props;
      props = null;
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // only used with trusted local strings
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      for (const c of children) appendChildren(node, c);
      return;
    }
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** Query helpers */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Badge with semantic color */
  function badge(text, kind = '', tip = null) {
    return el(`span.badge${kind ? `.badge-${kind}` : ''}`, tip ? { 'data-tip': tip } : null, [
      el('span.dot'),
      text,
    ]);
  }

  /** Label + value row for analysis panels */
  function statusRow(label, valueNode, tip) {
    return el('div.status-row', [
      el('span.label', { 'data-tip': tip || null }, label),
      el('span.value', valueNode instanceof Node ? valueNode : String(valueNode)),
    ]);
  }

  /** Button factory */
  function btn(label, opts = {}) {
    const { kind = '', size = '', onclick, disabled = false, tip = null, icon = null } = opts;
    const classes = ['btn'];
    if (kind) classes.push(`btn-${kind}`);
    if (size) classes.push(`btn-${size}`);
    return el(`button.${classes.join('.')}`, {
      onclick,
      disabled: disabled || undefined,
      'data-tip': tip,
      type: 'button',
      'aria-label': opts.ariaLabel || undefined,
    }, [icon ? el('span', { html: icon }) : null, label]);
  }

  /** Spinner element */
  function spinner() {
    return el('span.spinner');
  }

  /** Determinate/indeterminate progress bar; returns {node, set(percent|null)} */
  function progressBar(initial = null) {
    const fill = el('div.fill');
    const node = el('div.progress-bar', fill);
    const set = (pct) => {
      if (pct === null || pct === undefined) { node.classList.add('indeterminate'); fill.style.width = '40%'; }
      else { node.classList.remove('indeterminate'); fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
    };
    set(initial);
    return { node, set };
  }

  /** Step checklist renderer; returns {node, render(steps)} */
  function stepList(steps = []) {
    const node = el('div.step-list');
    const iconFor = (status) => {
      switch (status) {
        case 'done': return '✓';
        case 'failed': return '✕';
        case 'running': return spinner();
        case 'waiting': return '…';
        default: return '○';
      }
    };
    const render = (list) => {
      clear(node);
      for (const s of list || []) {
        node.appendChild(el(`div.step-item.${s.status || 'pending'}`, [
          el('span.step-icon', iconFor(s.status)),
          el('span', s.label || s.id),
          s.detail ? el('span.step-detail', s.detail) : null,
        ]));
      }
    };
    render(steps);
    return { node, render };
  }

  /** Initials tile for game cards */
  function coverTile(name) {
    const initials = String(name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase();
    return el('div.game-cover', { 'aria-hidden': 'true' }, initials || '?');
  }

  window.UI = window.UI || {};
  Object.assign(window.UI, { el, clear, $, $$, badge, statusRow, btn, spinner, progressBar, stepList, coverTile, appendChildren });
})();
