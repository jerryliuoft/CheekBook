import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { updateSettings, useSettings } from '../settings';
import { ConfirmButton } from './common';

export function LabView() {
  const s = useSettings();
  const timings = useLiveQuery(async () => {
    const all = await db.timings.toArray();
    const by = new Map<string, { n: number; total: number; last: number; detail?: string }>();
    for (const t of all) {
      const e = by.get(t.step) ?? { n: 0, total: 0, last: 0 };
      e.n++;
      e.total += t.ms;
      e.last = t.ms;
      e.detail = t.detail ?? e.detail;
      by.set(t.step, e);
    }
    return [...by];
  });

  async function clearAll() {
    await db.transaction('rw', [db.photos, db.faces, db.people, db.stickers, db.timings], () =>
      Promise.all([db.photos.clear(), db.faces.clear(), db.people.clear(), db.stickers.clear(), db.timings.clear()]),
    );
  }

  return (
    <section className="panel">
      <h2>Lab</h2>
      <p className="muted">
        Cross-origin isolated: {String(self.crossOriginIsolated)} (needed for multi-threaded CPU inference). The
        "load face models" timing below shows whether face finding runs on the GPU (webgpu) or CPU (wasm).
      </p>

      <h3>Settings</h3>
      <div className="settings">
        <label>
          Face detection confidence <b>{s.detScore.toFixed(2)}</b>
          <input type="range" min={0.2} max={0.9} step={0.05} value={s.detScore}
            onChange={(e) => updateSettings({ detScore: Number(e.target.value) })} />
          <span className="muted small">Lower finds more faces (and more false ones). Applies to new imports.</span>
        </label>
        <label>
          Grouping strictness <b>{s.clusterSim.toFixed(2)}</b>
          <input type="range" min={0.25} max={0.7} step={0.01} value={s.clusterSim}
            onChange={(e) => updateSettings({ clusterSim: Number(e.target.value) })} />
          <span className="muted small">Higher splits people into more groups. Use "Regroup automatically" to apply.</span>
        </label>
        <label>
          Smallest face (px) <b>{s.minFacePx}</b>
          <input type="range" min={16} max={120} step={4} value={s.minFacePx}
            onChange={(e) => updateSettings({ minFacePx: Number(e.target.value) })} />
        </label>
      </div>

      <h3>Timings on this computer</h3>
      {timings?.length ? (
        <table className="timings">
          <thead>
            <tr><th>Step</th><th>Runs</th><th>Average</th><th>Last</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {timings.map(([step, t]) => (
              <tr key={step}>
                <td>{step}</td>
                <td>{t.n}</td>
                <td>{(t.total / t.n / 1000).toFixed(2)} s</td>
                <td>{(t.last / 1000).toFixed(2)} s</td>
                <td className="muted">{t.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Nothing measured yet.</p>
      )}
      <div className="row">
        <button onClick={() => db.timings.clear()}>Clear timings</button>
        <ConfirmButton
          className="danger"
          label="Delete all data"
          question="Delete every photo, face, person and sticker in this browser? This can't be undone."
          confirmLabel="Delete everything"
          onConfirm={clearAll}
        />
      </div>
    </section>
  );
}
