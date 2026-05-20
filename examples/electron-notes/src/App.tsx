// db.notes.update() does not exist on Collection (M2 surface).
// db.transaction() does not exist on SchemaDatabase.
// Update uses delete + insert directly (sequential, not wrapped in a tx).
import React, { useMemo, useState } from 'react';
import { useLive } from '@nookdb/react';
import type { SchemaDatabase } from 'nookdb';
import type { schema } from './schema.js';
import { NoteList } from './components/NoteList.js';
import { NoteEditor } from './components/NoteEditor.js';

type DB = SchemaDatabase<typeof schema>;
type Note = (typeof schema)['notes']['$type'];

export function App({ db }: { db: DB }) {
  const notes = useLive(() => db.notes.live(), [db]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(
    () => notes.slice().sort((a, b) => +b.updatedAt - +a.updatedAt),
    [notes],
  );

  const selected = sorted.find((n) => n.id === selectedId) ?? sorted[0] ?? null;

  async function updateNote(n: Note, patch: Partial<Note>): Promise<void> {
    // No db.transaction() or Collection.update() on the TS surface yet.
    // Delete the existing document and re-insert with the patch applied.
    await db.notes.delete({ id: n.id });
    await db.notes.insert({ ...n, ...patch, updatedAt: new Date() });
  }

  return (
    <main
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        height: '100vh',
        fontFamily: 'ui-sans-serif, system-ui',
      }}
    >
      <aside style={{ borderRight: '1px solid #ddd', overflow: 'auto' }}>
        <NoteList
          notes={sorted}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onNew={async () => {
            await db.notes.insert({ title: 'Untitled' });
          }}
        />
      </aside>
      <section style={{ padding: 16, overflow: 'auto' }}>
        {selected === null ? (
          <p style={{ color: '#888' }}>No note selected. Create one from the sidebar.</p>
        ) : (
          <NoteEditor
            key={selected.id}
            note={selected}
            onChange={(patch) => { void updateNote(selected, patch); }}
            onDelete={async () => {
              await db.notes.delete({ id: selected.id });
              setSelectedId(null);
            }}
          />
        )}
      </section>
    </main>
  );
}
