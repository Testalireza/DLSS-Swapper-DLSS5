'use strict';

/**
 * Renderer ↔ core bridge.
 *
 * Under Electron: uses window.dlss5 (preload/contextBridge) with ipcRenderer.
 * In the browser dev-preview: uses HTTP POST /ipc + Server-Sent Events, the
 * exact same channels, handled by the exact same core services.
 *
 * Native pickers (folder/files) fall back to a manual path dialog in browser
 * mode so every workflow stays usable.
 */
(function () {
  const { IPC } = window.DLSS5Shared;
  const hasElectron = !!(window.dlss5 && typeof window.dlss5.invoke === 'function');

  let sse = null;
  const sseListeners = new Map(); // channel → Set(cb)

  function ensureSSE() {
    if (sse || hasElectron) return;
    try {
      sse = new EventSource('/events');
      sse.onerror = () => { /* EventSource auto-reconnects */ };
      // Named events arrive as 'message' only for unnamed; we send named events,
      // so subscribe lazily per channel on first listener.
    } catch {
      sse = null;
    }
  }

  function sseSubscribe(channel, cb) {
    ensureSSE();
    if (!sse) return () => {};
    if (!sseListeners.has(channel)) {
      const set = new Set();
      sseListeners.set(channel, set);
      sse.addEventListener(channel, (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { data = ev.data; }
        for (const fn of set) {
          try { fn(data); } catch (e) { console.error('event listener error', e); }
        }
      });
    }
    sseListeners.get(channel).add(cb);
    return () => sseListeners.get(channel).delete(cb);
  }

  async function invoke(channel, payload) {
    if (hasElectron) {
      const res = await window.dlss5.invoke(channel, payload);
      if (res && res.ok === false && res.stack && !window.UI.state?.settings?.advancedMode) {
        delete res.stack; // hide stack traces unless Advanced Mode
      }
      return res;
    }
    const res = await fetch('/ipc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload }),
    });
    if (!res.ok) throw new Error(`IPC transport error: HTTP ${res.status}`);
    return res.json();
  }

  function on(channel, cb) {
    if (hasElectron) return window.dlss5.on(channel, cb);
    return sseSubscribe(channel, cb);
  }

  /** Manual path entry for browser mode. Resolved by dialog.js at startup. */
  let pathPrompter = null;
  function setPathPrompter(fn) { pathPrompter = fn; }

  async function pickFolder(title) {
    if (hasElectron) {
      const r = await invoke(IPC.FS_PICK_FOLDER, { title });
      if (r && r.canceled) return null;
      return r && r.filePaths ? r.filePaths[0] : null;
    }
    const r = await invoke(IPC.FS_PICK_FOLDER);
    if (r && r.browserMode && pathPrompter) {
      return pathPrompter({ title: title || 'Enter a folder path', multiple: false });
    }
    return null;
  }

  async function pickFiles(title, extensions) {
    if (hasElectron) {
      const r = await invoke(IPC.FS_PICK_FILES, {
        title,
        multiple: true,
        filters: extensions ? [{ name: 'Allowed', extensions }, { name: 'All files', extensions: ['*'] }] : undefined,
      });
      if (r && r.canceled) return null;
      return r && r.filePaths ? r.filePaths : null;
    }
    const r = await invoke(IPC.FS_PICK_FILES);
    if (r && r.browserMode && pathPrompter) {
      const paths = await pathPrompter({ title: title || 'Enter file paths (one per line)', multiple: true });
      return paths ? [paths].flat() : null;
    }
    return null;
  }

  async function openPath(p) {
    if (!p) return;
    const r = await invoke(IPC.FS_OPEN_PATH, { path: p });
    if (r && r.browserMode) {
      window.UI.toast.info('Desktop only', `Opening folders works in the Windows app. Path: ${p}`);
    } else if (r && r.ok === false) {
      window.UI.toast.error('Could not open', r.error || p);
    }
  }

  async function showItem(p) {
    if (!p) return;
    const r = await invoke(IPC.FS_SHOW_ITEM, { path: p });
    if (r && r.browserMode) {
      window.UI.toast.info('Desktop only', `Revealing files works in the Windows app. Path: ${p}`);
    }
  }

  window.UI = window.UI || {};
  /**
   * Invoke a "…:openFolder"-style channel (e.g. backups/logs/library).
   * Desktop opens Explorer; the browser preview explains where the folder is.
   */
  async function openFolderVia(channel, payload) {
    const r = await invoke(channel, payload);
    if (r && r.browserMode) {
      window.UI.toast.info('Desktop only', `Opening folders works in the Windows app. Path: ${r.path || '(resolved server-side)'}`);
    } else if (r && r.ok === false) {
      window.UI.toast.error('Could not open', r.error || '');
    }
    return r;
  }

  window.UI.api = {
    invoke,
    on,
    pickFolder,
    pickFiles,
    openPath,
    openFolderVia,
    showItem,
    setPathPrompter,
    isElectron: hasElectron,
    platform: hasElectron ? window.dlss5.platform : navigator.platform,
    versions: hasElectron ? window.dlss5.versions : null,
    IPC,
  };
})();
