'use strict';

/**
 * DLSS Swapper 5 — Electron main process.
 *
 * Responsibilities here are deliberately thin: create the window, wire the
 * IPC transport onto the shared handler registry, and provide the desktop
 * hooks (native dialogs, shell). All application logic lives in src/core.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { AppEnv, resolveResourcesDir } = require('./src/core/env');
const { createServices } = require('./src/core/app-services');
const { createIpcHandlers, wrapAll } = require('./src/main/ipc-handlers');
const { APP } = require('./src/shared/constants');

let mainWindow = null;
let services = null;

function buildEnv() {
  const dataDir = process.env.DLSS5SWAPPER_DATA || app.getPath('userData');
  return new AppEnv({
    dataDir,
    resourcesDir: resolveResourcesDir(path.join(__dirname, 'resources')),
  });
}

function createWindow() {
  const settingsSnapshot = services ? services.settings._cache : null;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#F0F0F0',
    title: APP.name,
    icon: path.join(__dirname, 'resources', 'icons', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  void settingsSnapshot;

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Rescan games', accelerator: 'F5', click: () => mainWindow && mainWindow.webContents.send('ui:rescan') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About DLSS Swapper 5',
          click: () => dialog.showMessageBox(mainWindow, {
            title: `About ${APP.name}`,
            message: `${APP.name} v${APP.version}`,
            detail: `DLSS / Streamline runtime manager with DLSS 5 Neural Rendering support.\n\nLicense: ${APP.license}\nSource: ${APP.repository}`,
            buttons: ['OK'],
          }),
        },
        { label: 'Open source repository', click: () => shell.openExternal(APP.repository) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance — a second launch focuses the first window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const env = buildEnv();
    await env.ensureDirs();
    services = createServices({ env });
    await services.logger.info(`${APP.name} v${APP.version} starting (Electron ${process.versions.electron}, ${env.platform})`);
    services.logger.prune(14);

    const hooks = {
      isElectron: true,
      async openPath(p) {
        if (!p) return { ok: false, error: 'no path' };
        const err = await shell.openPath(p);
        return err ? { ok: false, error: err } : { ok: true };
      },
      async showItemInFolder(p) {
        if (p) shell.showItemInFolder(p);
        return { ok: !!p };
      },
      async pickFolder() {
        return dialog.showOpenDialog(mainWindow, {
          title: 'Select a folder',
          properties: ['openDirectory', 'createDirectory'],
        });
      },
      async pickFiles(opts = {}) {
        return dialog.showOpenDialog(mainWindow, {
          title: opts.title || 'Select files',
          properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          filters: opts.filters,
        });
      },
      async pickSaveFile(opts = {}) {
        return dialog.showSaveDialog(mainWindow, { defaultPath: opts.defaultPath });
      },
    };

    const handlers = wrapAll(createIpcHandlers(services, hooks), services.logger);
    for (const [channel, fn] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_event, payload) =>
        fn(payload, {
          emit: (ch, data) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
          },
        })
      );
    }

    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
