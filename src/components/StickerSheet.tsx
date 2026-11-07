import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, type Expression } from '../db';
import { EXPRESSIONS } from '../lib/expression';
import { toggled } from '../lib/util';
import { SHEET } from '../pipeline/book';
import { BlobImg } from './common';

export const STICKER_DRAG_TYPE = 'application/x-cheekbook-sticker';

/**
 * Stickers not in the book. Click one to add it to the open page, or drag it
 * to a spot on the page. Stickers taken off the page come back here by
 * themselves, newest first.
 */
export function StickerSheet({ onAdd, disabled }: { onAdd: (id: number) => void; disabled?: boolean }) {
  const data = useLiveQuery(async () => {
    const stickers = (await db.stickers.where('page').equals(SHEET).toArray()).sort((a, b) => b.createdAt - a.createdAt);
    const faces = await db.faces.bulkGet(stickers.map((s) => s.faceId));
    const people = new Map((await db.people.toArray()).map((p) => [p.id, p.name]));
    return stickers.map((s, i) => ({ sticker: s, expression: faces[i]?.expression, person: people.get(s.personId) }));
  });
  const [personId, setPersonId] = useState<number | null>(null);
  const [moods, setMoods] = useState<Set<Expression>>(new Set());

  if (!data) return <aside className="sheet" />;

  const people = [...new Map(data.map((d) => [d.sticker.personId, d.person ?? 'Someone'])).entries()];
  const forPerson = data.filter((d) => personId == null || d.sticker.personId === personId);
  const shown = forPerson.filter((d) => !moods.size || (d.expression && moods.has(d.expression)));
  const moodCount = (m: Expression) => forPerson.filter((d) => d.expression === m).length;

  return (
    <aside className="sheet">
      <div className="sheet-head">
        <h2>Sticker sheet</h2>
        <span className="muted small">{data.length} left</span>
      </div>
      {data.length > 0 && (
        <div className="filters">
          {people.length > 1 && (
            <select
              value={personId ?? ''}
              onChange={(e) => setPersonId(e.target.value ? Number(e.target.value) : null)}
              aria-label="Whose stickers"
            >
              <option value="">Everyone</option>
              {people.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <div className="filter-row">
            {(Object.keys(EXPRESSIONS) as Expression[]).map((m) => {
              const n = moodCount(m);
              return n ? (
                <button
                  key={m}
                  className={`chip small ${moods.has(m) ? 'on' : ''}`}
                  onClick={() => setMoods(toggled(moods, m))}
                >
                  {EXPRESSIONS[m]} · {n}
                </button>
              ) : null;
            })}
          </div>
        </div>
      )}
      {!data.length ? (
        <p className="sheet-empty">Every sticker is in the book. Drag one off a page to bring it back here.</p>
      ) : !shown.length ? (
        <p className="sheet-empty">No stickers match.</p>
      ) : (
        <div className="sheet-grid">
          {shown.map(({ sticker }) => (
            <div key={sticker.id} className="sheet-item">
              <button
                className="sheet-sticker"
                disabled={disabled}
                draggable={!disabled}
                title="Add to this page (or drag it onto the page)"
                onClick={() => onAdd(sticker.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(STICKER_DRAG_TYPE, String(sticker.id));
                  e.dataTransfer.effectAllowed = 'move';
                }}
              >
                <BlobImg blob={sticker.blob} />
              </button>
              <button
                className="sheet-delete"
                title="Delete this sticker"
                aria-label="Delete this sticker"
                onClick={() => db.stickers.delete(sticker.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
