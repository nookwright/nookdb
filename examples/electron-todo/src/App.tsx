// db.todos.update() does not exist on Collection (M2 surface).
// db.transaction() does not exist on SchemaDatabase.
// Toggle uses delete + insert directly (sequential, not wrapped in a tx).
import React, { useState } from 'react';
import { useLive } from '@nookdb/react';
import type { SchemaDatabase } from 'nookdb';
import type { schema } from './schema.js';

type DB = SchemaDatabase<typeof schema>;

/** Inferred document type for a todo — derived from the live schema phantom. */
type Todo = (typeof schema)['todos']['$type'];

export function App({ db }: { db: DB }) {
  const todos = useLive(() => db.todos.live(), [db]);
  const [title, setTitle] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length === 0) return;
    await db.todos.insert({ title: title.trim() });
    setTitle('');
  }

  async function toggle(t: Todo) {
    // No update() or transaction() on the public surface.
    // Delete the existing document and re-insert with the flipped `done` flag.
    await db.todos.delete({ id: t.id });
    await db.todos.insert({ ...t, done: !t.done });
  }

  async function remove(t: Todo) {
    await db.todos.delete({ id: t.id });
  }

  return (
    <main style={{ fontFamily: 'ui-sans-serif, system-ui', maxWidth: 640, margin: '2rem auto' }}>
      <h1>todo · nookdb</h1>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">Add</button>
      </form>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos.map((t) => (
          <li key={t.id} style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() => { void toggle(t); }}
            />
            <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : 'none' }}>{t.title}</span>
            <button onClick={() => { void remove(t); }}>×</button>
          </li>
        ))}
      </ul>
      <p style={{ color: '#666', marginTop: 24 }}>
        {todos.length} item{todos.length === 1 ? '' : 's'} · {todos.filter((t) => !t.done).length} unfinished
      </p>
    </main>
  );
}
