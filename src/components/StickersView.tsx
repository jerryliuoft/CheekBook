import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { db, type CropKind, type Expression, type Looking } from '../db';
import { hasCurrentCrops } from '../lib/crops';
import { EXPRESSIONS, LOOKING } from '../lib/expression';
import { toggled } from '../lib/util';
import { analyzeFaces, makeStickers, needsAnalysis, type StickerJob } from '../pipeline/makeStickers';
import { BlobImg, Empty, Progress } from './common';

const KIND_LABEL: Record<CropKind, string> = { face: 'Face', upper: 'Upper body', full: 'Full body' };
const KINDS: CropKind[] = ['face', 'upper', 'full'];
const key = (faceId: number, kind: CropKind) => `${faceId}:${kind}`;
const faceOf = (k: string) => Number(k.split(':')[0]);

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
  const [moods, setMoods] = useState<Set<Expression>>(new Set());
  const [looks, setLooks] = useState<Set<Looking>>(new Set());

  // Work out which crops each face supports and read its expression (once per face).
  const missing = useMemo(() => (faces ?? []).filter(needsAnalysis), [faces]);
  useEffect(() => {
    if (!missing.length || analyzing) return;
    let done = 0;
    setAnalyzing({ done, total: missing.length });
    analyzeFaces(missing, () => setAnalyzing({ done: ++done, total: missing.length })).finally(() =>
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

  const sorted = [...(faces ?? [])].sort((a, b) => b.box[2] - b.box[0] - (a.box[2] - a.box[0]));
  const visible = sorted.filter(
    (f) =>
      (!moods.size || (f.expression && moods.has(f.expression))) && (!looks.size || (f.looking && looks.has(f.looking))),
  );
  // Only what's on screen gets made, so a filter never makes hidden stickers.
  const visibleIds = new Set(visible.map((f) => f.id));
  const toMake = [...picked].filter((k) => visibleIds.has(faceOf(k)));
  const count = <T,>(get: (f: (typeof sorted)[number]) => T | undefined, v: T) => sorted.filter((f) => get(f) === v).length;

  if (!people) return null;
  if (!people.length) return <Empty>No people yet. Bring in some photos first.</Empty>;

  async function run() {
    const jobs: StickerJob[] = toMake.map((k) => {
      const [faceId, kind] = k.split(':');
      return { faceId: Number(faceId), kind: kind as CropKind };
    });
    setMaking({ done: 0, total: jobs.length, msg: 'Starting…' });
    await makeStickers(jobs, (done, total, msg) => setMaking({ done, total, msg }));
    setPicked(new Set());
    setMaking(null);
    onDone();
  }

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
              setMoods(new Set());
              setLooks(new Set());
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
        <button className="primary" disabled={!toMake.length || !!making} onClick={run}>
          Make {toMake.length} sticker{toMake.length === 1 ? '' : 's'}
        </button>
      </div>
      {personId != null && sorted.length > 0 && (
        <div className="filters">
          <div className="filter-row">
            {(Object.keys(EXPRESSIONS) as Expression[]).map((m) => {
              const n = count((f) => f.expression, m);
              return n ? (
                <button key={m} className={`chip small ${moods.has(m) ? 'on' : ''}`} onClick={() => setMoods(toggled(moods, m))}>
                  {EXPRESSIONS[m]} · {n}
                </button>
              ) : null;
            })}
          </div>
          <div className="filter-row">
            {(Object.keys(LOOKING) as Looking[]).map((l) => {
              const n = count((f) => f.looking, l);
              return n ? (
                <button key={l} className={`chip small ${looks.has(l) ? 'on' : ''}`} onClick={() => setLooks(toggled(looks, l))}>
                  {LOOKING[l]} · {n}
                </button>
              ) : null;
            })}
          </div>
        </div>
      )}
      <p className="muted small">
        Bigger crops are only offered when the person is large enough in the photo to make a sharp sticker.
      </p>
      {analyzing && <Progress done={analyzing.done} total={analyzing.total} label="Reading faces and body poses…" />}
      {making && <Progress done={making.done} total={making.total} label={making.msg} />}

      {personId == null ? (
        <Empty>Pick a person above.</Empty>
      ) : !visible.length && sorted.length ? (
        <Empty>No faces match these filters.</Empty>
      ) : (
        <div className="crop-list">
          {visible.map((f) => (
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
              {f.expression && (
                <span className="crop-tag">
                  {EXPRESSIONS[f.expression].toLowerCase()}
                  <br />
                  {LOOKING[f.looking!].toLowerCase()}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
