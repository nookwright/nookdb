import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openHost } from '@nookdb/electron/main';
import { schema } from '../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function createWindow() {
  const host = await openHost(resolve(HERE, '../app.db'), { schema });

  const win = new BrowserWindow({
    width: 720,
    height: 600,
    webPreferences: {
      preload: join(HERE, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  const { port1, port2 } = new MessageChannelMain();
  host.connectPort(port1, {
    frameUrl: null,
    origin: null,
    webContentsId: win.webContents.id,
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.postMessage('nook:port', null, [port2]);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await win.loadFile(join(HERE, '../dist/index.html'));
  }
}

app.whenReady().then(createWindow).catch(console.error);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
