'use strict';

/**
 * Preload — the ONLY bridge between renderer and main.
 * contextIsolation is on; the renderer gets a minimal, promise-based API.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dlss5', {
  /** Invoke a core service through the shared IPC registry. */
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  /** Subscribe to push events (operation progress, scan progress, ...).
   *  Returns an unsubscribe function. */
  on: (channel, callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  environment: 'electron',
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
