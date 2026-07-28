'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchMenu } = require('./menu');

// L'Osteria Bonn Portlandweg (53227) – "Rheinwerk"
const VENUE_ID = '67b87e42e1690c89bedf3875';

function cachePath() {
  return path.join(app.getPath('userData'), 'menu-cache.json');
}

function seedPath() {
  return path.join(__dirname, '..', 'renderer', 'menu-seed.json');
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Lädt die Speisekarte: zuerst live von der API, sonst aus dem lokalen Cache,
 * sonst aus dem mitgelieferten Seed. Bei Erfolg wird der Cache aktualisiert.
 */
ipcMain.handle('menu:load', async () => {
  try {
    const menu = await fetchMenu(VENUE_ID);
    try {
      fs.writeFileSync(cachePath(), JSON.stringify(menu), 'utf8');
    } catch {
      /* Cache-Schreiben ist optional */
    }
    return { menu, source: 'live' };
  } catch (err) {
    const message = String((err && err.message) || err);
    const cached = readJsonSafe(cachePath());
    if (cached) return { menu: cached, source: 'cache', error: message };
    const seed = readJsonSafe(seedPath());
    if (seed) return { menu: seed, source: 'seed', error: message };
    return { menu: null, source: 'none', error: message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    autoHideMenuBar: true,
    backgroundColor: '#f7f2e9',
    title: "L'Osteria Bestellrechner",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Externe Links (z. B. Bildquellen) im Standardbrowser öffnen, nicht in der App.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
