import type { ReactNode } from 'react';
import { useObjectUrl } from '../lib/image';

export function BlobImg({ blob, alt = '', className }: { blob?: Blob | null; alt?: string; className?: string }) {
  const url = useObjectUrl(blob);
  return url ? <img src={url} alt={alt} className={className} draggable={false} /> : <div className={className} />;
}

export function Progress({ done, total, label }: { done: number; total: number; label?: ReactNode }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-label">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
