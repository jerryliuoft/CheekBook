import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db, type Face, type Person } from '../db';
import { mergePeople, regroupAll, splitFace } from '../lib/cluster';
import { hasCurrentCrops } from '../lib/crops';
import { groupBy, toggled } from '../lib/util';
import { makeStickersFor } from '../pipeline/makeStickers';
import { useSettings } from '../settings';
import { BlobImg, Empty, Progress } from './common';

interface PersonRow {
  person: Person;
  faces: Face[];
  made: number; // faces with a sticker
  toMake: number; // faces that can still get one
}

export function PeopleView({ onOpenBook }: { onOpenBook: () => void }) {
  const settings = useSettings();
  const data = useLiveQuery(async () => {
    const [people, faces, stickers] = await Promise.all([db.people.toArray(), db.faces.toArray(), db.stickers.toArray()]);
    const byPerson = groupBy(faces, (f) => f.personId);
    const withSticker = new Set(stickers.map((s) => s.faceId));
    return people
      .map((p): PersonRow => {
        const fs = byPerson.get(p.id) ?? [];
        const made = fs.filter((f) => withSticker.has(f.id)).length;
        // Faces already checked and found too small or cut off get none.
        const toMake = fs.filter((f) => !withSticker.has(f.id) && !(hasCurrentCrops(f) && f.best == null)).length;
        return { person: p, faces: fs, made, toMake };
      })
      .filter((r) => r.faces.length)
      .sort((a, b) => b.faces.length - a.faces.length);
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState<{ done: number; total: number; msg: string } | null>(null);
  const [made, setMade] = useState<number | null>(null);

  const [main, others] = useMemo(() => {
    const rows = data ?? [];
    return [rows.filter((r) => r.faces.length > 1), rows.filter((r) => r.faces.length === 1)];
  }, [data]);

  if (!data) return null;
  if (!data.length) return <Empty>No faces yet. Bring in some photos first.</Empty>;

  async function merge() {
    const ids = [...selected];
    // Merge into the biggest selected group.
    const target = data!.filter((r) => selected.has(r.person.id)).sort((a, b) => b.faces.length - a.faces.length)[0];
    await mergePeople(target.person.id, ids.filter((id) => id !== target.person.id));
    setSelected(new Set());
  }

  async function make(ids: number[]) {
    setMade(null);
    setMaking({ done: 0, total: 1, msg: 'Starting…' });
    try {
      setMade(await makeStickersFor(ids, (done, total, msg) => setMaking({ done, total, msg })));
      setSelected(new Set());
    } finally {
      setMaking(null);
    }
  }

  const selectedToMake = data.filter((r) => selected.has(r.person.id)).reduce((n, r) => n + r.toMake, 0);

  async function regroup() {
    setBusy(true);
    await regroupAll(settings.clusterSim);
    setBusy(false);
  }

  const card = (r: PersonRow) => (
    <PersonCard
      key={r.person.id}
      row={r}
      selected={selected.has(r.person.id)}
      open={open === r.person.id}
      onToggle={() => setSelected(toggled(selected, r.person.id))}
      onOpen={() => setOpen(open === r.person.id ? null : r.person.id)}
      busy={!!making}
      onMake={() => make([r.person.id])}
    />
  );

  return (
    <section className="panel">
      <h2>Who gets stickers</h2>
      <p className="muted">
        Faces are grouped by person automatically. Baby faces change fast, so your baby may show up in a few groups:
        tick them and press <b>Merge</b>. Open a group to remove faces that don't belong. Then make stickers: each
        photo becomes a face sticker, or a body sticker when the face is small or soft, and anything the baby holds
        stays in.
      </p>
      <div className="row sticky-actions">
        <button className="primary" disabled={!selectedToMake || !!making} onClick={() => make([...selected])}>
          Make {selectedToMake || ''} sticker{selectedToMake === 1 ? '' : 's'}
        </button>
        <button disabled={selected.size < 2 || !!making} onClick={merge}>
          Merge {selected.size >= 2 ? selected.size : ''} selected
        </button>
        {selected.size > 0 && <button onClick={() => setSelected(new Set())}>Clear selection</button>}
        <span className="spacer" />
        <button disabled={busy || !!making} onClick={regroup} title="Keeps faces you moved by hand">
          {busy ? 'Regrouping…' : 'Regroup automatically'}
        </button>
      </div>
      {making && <Progress done={making.done} total={making.total} label={making.msg} />}
      {made != null && !making && (
        <p className="ok">
          {made ? `Made ${made} sticker${made === 1 ? '' : 's'}.` : 'Nothing new to make.'}{' '}
          <button className="link" onClick={onOpenBook}>
            Open the scrapbook →
          </button>
        </p>
      )}
      <div className="people">{main.map(card)}</div>
      {others.length > 0 && (
        <>
          <button className="link" onClick={() => setShowOthers(!showOthers)}>
            {showOthers ? 'Hide' : 'Show'} {others.length} people seen only once
          </button>
          {showOthers && <div className="people">{others.map(card)}</div>}
        </>
      )}
    </section>
  );
}

function PersonCard(props: {
  row: PersonRow;
  selected: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  busy: boolean;
  onMake: () => void;
}) {
  const { person, faces, made, toMake } = props.row;
  const cover = faces.find((f) => f.id === person.coverFaceId) ?? faces[0];
  const [name, setName] = useState(person.name);

  return (
    <div className={`person ${props.selected ? 'selected' : ''} ${props.open ? 'open' : ''}`}>
      <div className="person-head">
        <label className="check">
          <input type="checkbox" checked={props.selected} onChange={props.onToggle} />
        </label>
        <button className="cover" onClick={props.onOpen} title="Show all faces">
          <BlobImg blob={cover.thumb} />
        </button>
        <div className="person-meta">
          <input
            className="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => db.people.update(person.id, { name })}
          />
          <div className="muted small">
            {faces.length} photo{faces.length === 1 ? '' : 's'}
            {made > 0 && ` · ${made} sticker${made === 1 ? '' : 's'}`}
          </div>
          {toMake > 0 ? (
            <button className="small primary" disabled={props.busy} onClick={props.onMake}>
              Make {toMake} sticker{toMake === 1 ? '' : 's'}
            </button>
          ) : (
            made > 0 && <span className="ok small">All stickers made</span>
          )}
        </div>
      </div>
      {props.open && (
        <div className="face-grid">
          {faces.map((f) => (
            <div key={f.id} className="face">
              <BlobImg blob={f.thumb} />
              <div className="face-actions">
                <button title="Use as cover" onClick={() => db.people.update(person.id, { coverFaceId: f.id })}>
                  ★
                </button>
                <button title="Not this person" onClick={() => splitFace(f.id)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
