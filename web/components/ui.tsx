'use client';
import { useState } from 'react';
import { shortId } from '@/lib/format';

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}

export function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="metric">
      <p className="label">{label}</p>
      <p className="value amount">{value}</p>
      {hint && <p className="label" style={{ margin: '6px 0 0' }}>{hint}</p>}
    </div>
  );
}

type BadgeKind = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
export function Badge({ kind, children }: { kind: BadgeKind; children: React.ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'accent';
  type?: 'button' | 'submit';
}) {
  const cls = variant === 'primary' ? 'btn btn-primary' : variant === 'accent' ? 'btn btn-accent' : 'btn';
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Monospace 0x… chip; click to copy. The canonical way addresses/ids render across iSub. */
export function AddressChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className="chip"
      title={id}
      onClick={() => {
        void navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {shortId(id)}
      <span style={{ fontSize: 11, opacity: 0.55 }}>{copied ? 'copied' : 'copy'}</span>
    </span>
  );
}
