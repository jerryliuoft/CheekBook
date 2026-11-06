import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { db } from '../db';
import { addFiles, processPending, type ImportProgress } from '../pipeline/importPhotos';
import { Progress } from './common';

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  copying: 'Copying photos into the app',
  'loading-models': 'Loading face models',
  'finding-faces': 'Finding faces',
  grouping: 'Grouping faces into people',
  done: 'Done',
};

export function ImportView({ onDone }: { onDone: () => void }) {
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string>();
  const stats = useLiveQuery(async () => ({
    photos: await db.photos.count(),
    pending: await db.photos.where('status').equals('pending').count(),
    failed: await db.photos.where('status').equals('error').count(),
    faces: await db.faces.count(),
    people: await db.people.count(),
  }));
  const busy = !!progress && progress.phase !== 'done';

  async function run(files: File[] | null) {
    setError(undefined);
    try {
      if (files?.length) await addFiles(files, setProgress);
      await processPending(setProgress);
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  }

  return (
    <section className="panel">
      <h2>1 · Bring in your photos</h2>
      <p className="muted">
        Photos stay on this computer. CheekBook stores a resized copy in your browser and finds every face in them.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => folderInput.current?.click()}>
          Choose a folder
        </button>
        <button disabled={busy} onClick={() => filesInput.current?.click()}>
          Choose photos
        </button>
        {!!stats?.pending && !busy && <button onClick={() => run(null)}>Resume ({stats.pending} left)</button>}
      </div>
      <input
        ref={folderInput}
        type="file"
        hidden
        multiple
        // @ts-expect-error non-standard but widely supported folder picker
        webkitdirectory=""
        onChange={(e) => run(Array.from(e.target.files ?? []))}
      />
      <input
        ref={filesInput}
        type="file"
        hidden
        multiple
        accept="image/*"
        onChange={(e) => run(Array.from(e.target.files ?? []))}
      />

      {progress && progress.phase !== 'done' && (
        <Progress
          done={progress.done}
          total={progress.total}
          label={`${PHASE_LABEL[progress.phase]}… ${progress.total > 1 ? `${progress.done} / ${progress.total}` : ''}`}
        />
      )}
      {progress?.phase === 'done' && (
        <p className="ok">
          All photos processed. <button className="link" onClick={onDone}>Go pick your baby →</button>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {stats && (
        <div className="stats">
          <div><b>{stats.photos}</b> photos</div>
          <div><b>{stats.faces}</b> faces</div>
          <div><b>{stats.people}</b> people</div>
          {stats.failed > 0 && <div className="error"><b>{stats.failed}</b> couldn't be read</div>}
        </div>
      )}
      <p className="muted small">JPEG, PNG, WebP and AVIF are supported. iPhone HEIC photos aren't yet.</p>
    </section>
  );
}
