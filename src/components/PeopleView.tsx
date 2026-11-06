import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db, type Face, type Person } from '../db';
import { mergePeople, regroupAll, splitFace } from '../lib/cluster';
import { useSettings } from '../settings';
import { BlobImg, Empty } from './common';

interface PersonRow {
  person: Person;
  faces: Face[];
}

export function PeopleView({ onPick }: { onPick: (personId: number) => void }) {
  const settings = useSettings();
  const data = useLiveQuery(async () => {
    const [people, faces] = await Promise.all([db.people.toArray(), db.faces.toArray()]);
    const byPerson = new Map<number, Face[]>();
    for (const f of faces) {
      if (f.personId == null) continue;
      const list = byPerson.get(f.personId) ?? [];
      list.push(f);
      byPerson.set(f.personId, list);
    }
    return people
      .map((p) => ({ person: p, faces: byPerson.get(p.id) ?? [] }))
      .filter((r) => r.faces.length)
      .sort((a, b) => b.faces.length - a.faces.length);
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState(false);

  const [main, others] = useMemo(() => {
    const rows = data ?? [];
    return [rows.filter((r) => r.faces.length > 1), rows.filter((r) => r.faces.length === 1)];
  }, [data]);

  if (!data) return null;
  if (!data.length) return <Empty>No faces yet. Bring in some photos first.</Empty>;

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function merge() {
    const ids = [...selected];
    // Merge into the biggest selected group.
    const target = data!.filter((r) => selected.has(r.person.id)).sort((a, b) => b.faces.length - a.faces.length)[0];
    await mergePeople(target.person.id, ids.filter((id) => id !== target.person.id));
    setSelected(new Set());
  }

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
      onToggle={() => toggle(r.person.id)}
      onOpen={() => setOpen(open === r.person.id ? null : r.person.id)}
      onPick={() => onPick(r.person.id)}
    />
  );

  return (
    <section className="panel">
      <h2>2 · Who's who</h2>
      <p className="muted">
        Faces are grouped by person automatically. Baby faces change fast, so your baby may show up in a few groups:
        tick them and press <b>Merge</b>. Open a group to remove faces that don't belong.
      </p>
      <div className="row sticky-actions">
        <button className="primary" disabled={selected.size < 2} onClick={merge}>
          Merge {selected.size >= 2 ? selected.size : ''} selected
        </button>
        {selected.size > 0 && <button onClick={() => setSelected(new Set())}>Clear selection</button>}
        <span className="spacer" />
        <button disabled={busy} onClick={regroup} title="Keeps faces you moved by hand">
          {busy ? 'Regrouping…' : 'Regroup automatically'}
        </button>
      </div>
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
  onPick: () => void;
}) {
  const { person, faces } = props.row;
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
          <div className="muted small">{faces.length} photo{faces.length === 1 ? '' : 's'}</div>
          <button className="small primary" onClick={props.onPick}>
            Make stickers →
          </button>
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
