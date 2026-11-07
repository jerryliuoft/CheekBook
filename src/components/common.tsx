import { useState, type ReactNode } from 'react';
import { useObjectUrl } from './hooks';

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

/**
 * A button that asks "are you sure?" on the page before acting. Embedded
 * browsers (like the desktop app's pane) block window.confirm, which then
 * returns false at once, so never use it.
 */
export function ConfirmButton(props: {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => unknown;
  disabled?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={props.className} disabled={props.disabled} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <span className="small">{props.question}</span>
      <button
        className="danger"
        disabled={props.disabled}
        onClick={async () => {
          setAsking(false);
          await props.onConfirm();
        }}
      >
        {props.confirmLabel}
      </button>
      <button onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
