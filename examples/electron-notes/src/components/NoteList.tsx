import React from 'react';

interface Note { id: string; title: string; updatedAt: Date }

export function NoteList(props: {
  notes: Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { notes, selectedId, onSelect, onNew } = props;
  return (
    <div>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong>Notes</strong>
        <button onClick={onNew} style={{ fontSize: 12 }}>
          + New
        </button>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {notes.map((n) => (
          <li
            key={n.id}
            onClick={() => { onSelect(n.id); }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              background: n.id === selectedId ? '#e0e7ff' : 'transparent',
              borderBottom: '1px solid #eee',
            }}
          >
            <div style={{ fontWeight: 500 }}>{n.title.length > 0 ? n.title : '(untitled)'}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{new Date(n.updatedAt).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
