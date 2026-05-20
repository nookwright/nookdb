import React from 'react';

interface Note { id: string; title: string; body: string; updatedAt: Date }

export function NoteEditor(props: {
  note: Note;
  onChange: (patch: Partial<Note>) => void;
  onDelete: () => void | Promise<void>;
}) {
  const { note, onChange, onDelete } = props;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input
        value={note.title}
        onChange={(e) => { onChange({ title: e.target.value }); }}
        style={{ fontSize: 22, padding: 4, border: 'none', borderBottom: '1px solid #ddd', outline: 'none' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => { void onDelete(); }}
          style={{ color: 'crimson', background: 'none', border: '1px solid crimson', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
        >
          Delete
        </button>
      </div>
      <textarea
        value={note.body}
        onChange={(e) => { onChange({ body: e.target.value }); }}
        style={{
          flex: 1,
          minHeight: 320,
          fontFamily: 'ui-monospace, monospace',
          padding: 8,
          border: '1px solid #ddd',
          borderRadius: 4,
          resize: 'vertical',
        }}
      />
    </div>
  );
}
