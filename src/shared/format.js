'use strict';

/**
 * UMD module — loaded by Node (core/tests) AND directly in the renderer via
 * a <script> tag (browser preview + Electron), so both worlds share one
 * source of truth.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DLSS5Shared = Object.assign({}, root.DLSS5Shared, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {

/**
 * Small formatting + comparison helpers shared by core and renderer.
 */

/**
 * Compare two dotted version strings numerically.
 * Returns <0 if a<b, 0 if equal, >0 if a>b. Non-numeric segments fall back to
 * string comparison so odd vendor versions still order deterministically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] === undefined ? '0' : pa[i];
    const sb = pb[i] === undefined ? '0' : pb[i];
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Format a byte count as a human readable string. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Format an ISO timestamp (or Date) for display, e.g. "September 12, 2026 14:03". */
function formatDateTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

/** Format a Date for compact list rows, e.g. "2026-09-12 14:03". */
function formatDateTimeShort(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact backup/operation id, e.g. "20260912-140305-a1b2". */
function makeId(prefixDate = new Date()) {
  const d = prefixDate;
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${rand}`;
}

/** Title-case a slug: "aurora-protocol" -> "Aurora Protocol". */
function titleCase(text) {
  return String(text)
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Truncate with ellipsis in the middle, for long paths in the UI. */
function ellipsizeMiddle(text, max = 48) {
  const s = String(text);
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}


return {

  compareVersions,
  formatBytes,
  formatDateTime,
  formatDateTimeShort,
  makeId,
  titleCase,
  ellipsizeMiddle,

};
});
