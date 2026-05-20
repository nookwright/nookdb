import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openHost } from '@nookdb/electron/main';
import { schema } from '../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function openWindow(
  host: Awaited<ReturnType<typeof openHost>>,
  x: number,
): Promise<void> {
  const win = new BrowserWindow({
    width: 600,
    height: 700,
    x,
    y: 80,
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

  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await win.loadFile(join(HERE, '../dist/index.html'));
  }
}

async function boot(): Promise<void> {
  const host = await openHost(resolve(HERE, '../notes.db'), { schema });
  await openWindow(host, 50);
  await openWindow(host, 700);
}

app.whenReady().then(boot).catch(console.error);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
