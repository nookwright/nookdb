import React from 'react';
import { createRoot } from 'react-dom/client';
import { connectNook } from '@nookdb/electron/renderer';
import { App } from './App.js';
import { schema } from './schema.js';

async function boot() {
  const db = await connectNook({ schema });
  const rootEl = document.getElementById('root');
  if (rootEl === null) throw new Error('no #root element');
  const root = createRoot(rootEl);
  root.render(<App db={db} />);
}

boot().catch((err: unknown) => {
  document.body.innerHTML = `<pre style="color:red">${(err as Error).stack ?? String(err)}</pre>`;
});
