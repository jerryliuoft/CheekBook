import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { db, type CropKind } from '../db';
import { hasCurrentCrops } from '../lib/crops';
import { toggled } from '../lib/util';
import { ensureCrops, makeStickers, type StickerJob } from '../pipeline/makeStickers';
import { BlobImg, Empty, Progress } from './common';

const KIND_LABEL: Record<CropKind, string> = { face: 'Face', upper: 'Upper body', full: 'Full body' };
const KINDS: CropKind[] = ['face', 'upper', 'full'];
const key = (faceId: number, kind: CropKind) => `${faceId}:${kind}`;

export function StickersView({
  personId,
  onPersonChange,
  onDone,
}: {
  personId: number | null;
  onPersonChange: (id: number) => void;
  onDone: () => void;
}) {
  const people = useLiveQuery(async () => {
    const ps = await db.people.toArray();
    const counts = await Promise.all(ps.map((p) => db.faces.where('personId').equals(p.id).count()));
    return ps.map((p, i) => ({ ...p, count: counts[i] })).filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  });
  const faces = useLiveQuery(
    () => (personId == null ? [] : db.faces.where('personId').equals(personId).toArray()),
    [personId],
  );
  const photos = useLiveQuery(async () => {
    if (!faces?.length) return new Map();
    const list = await db.photos.bulkGet([...new Set(faces.map((f) => f.photoId))]);
    return new Map(list.filter(Boolean).map((p) => [p!.id, p!]));
  }, [faces]);
  const madeFor = useLiveQuery(
    async () => ({
      personId,
      keys: new Set(
        (personId == null ? [] : await db.stickers.where('personId').equals(personId).toArray()).map((s) =>
          key(s.faceId, s.kind),
        ),
      ),
    }),
    [personId],
  );
  // Ignore a result left over from the previously selected person.
  const made = madeFor?.personId === personId ? madeFor.keys : undefined;

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  const [making, setMaking] = useState<{ done: number; total: number; msg: string } | null>(null);

  // Work out which crops each face supports (runs the pose model once per photo).
  const missing = useMemo(() => (faces ?? []).filter((f) => !hasCurrentCrops(f)), [faces]);
  useEffect(() => {
    if (!missing.length || analyzing) return;
    let done = 0;
    setAnalyzing({ done, total: missing.length });
    ensureCrops(missing, () => setAnalyzing({ done: ++done, total: missing.length })).finally(() =>
      setAnalyzing(null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.length]);

  // Default selection: the face crop of every face without a sticker yet.
  const [defaultsFor, setDefaultsFor] = useState<number | null>(null);
  useEffect(() => {
    if (!faces || !made || personId == null || defaultsFor === personId) return;
    if (faces.some((f) => f.personId !== personId || !hasCurrentCrops(f))) return; // wait for this person's crops
    setDefaultsFor(personId);
    setPicked(() => {
      const next = new Set<string>();
      for (const f of faces) {
        const c = f.crops?.find((c) => c.kind === 'face');
        if (c?.available && !made.has(key(f.id, 'face'))) next.add(key(f.id, 'face'));
      }
      return next;
    });
  }, [faces, made, personId, defaultsFor]);

  if (!people) return null;
  if (!people.length) return <Empty>No people yet. Bring in some photos first.</Empty>;

  async function run() {
    const jobs: StickerJob[] = [...picked].map((k) => {
      const [faceId, kind] = k.split(':');
      return { faceId: Number(faceId), kind: kind as CropKind };
    });
    setMaking({ done: 0, total: jobs.length, msg: 'Starting…' });
    await makeStickers(jobs, (done, total, msg) => setMaking({ done, total, msg }));
    setPicked(new Set());
    setMaking(null);
    onDone();
  }

  const sorted = [...(faces ?? [])].sort((a, b) => b.box[2] - b.box[0] - (a.box[2] - a.box[0]));

  return (
    <section className="panel">
      <h2>3 · Choose the crops</h2>
      <div className="row">
        <label>
          Person{' '}
          <select
            value={personId ?? ''}
            onChange={(e) => {
              setPicked(new Set());
              onPersonChange(Number(e.target.value));
            }}
          >
            <option value="" disabled>
              Pick someone…
            </option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.count})
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="primary" disabled={!picked.size || !!making} onClick={run}>
          Make {picked.size} sticker{picked.size === 1 ? '' : 's'}
        </button>
      </div>
      <p className="muted small">
        Bigger crops are only offered when the person is large enough in the photo to make a sharp sticker.
      </p>
      {analyzing && <Progress done={analyzing.done} total={analyzing.total} label="Checking body poses…" />}
      {making && <Progress done={making.done} total={making.total} label={making.msg} />}

      {personId == null ? (
        <Empty>Pick a person above.</Empty>
      ) : (
        <div className="crop-list">
          {sorted.map((f) => (
            <div key={f.id} className="crop-row">
              <BlobImg blob={photos?.get(f.photoId)?.thumb} className="crop-photo" />
              <BlobImg blob={f.thumb} className="crop-face" />
              <div className="crop-options">
                {KINDS.map((kind) => {
                  const c = f.crops?.find((c) => c.kind === kind);
                  const k = key(f.id, kind);
                  const has = made?.has(k);
                  return (
                    <button
                      key={kind}
                      className={`chip ${picked.has(k) ? 'on' : ''}`}
                      disabled={!c?.available || !!making}
                      title={c?.reason ?? ''}
                      onClick={() => setPicked(toggled(picked, k))}
                    >
                      {KIND_LABEL[kind]}
                      {has ? ' ✓' : ''}
                      {c && !c.available && <span className="why">{c.reason}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
