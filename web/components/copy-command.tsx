'use client';
import { useState } from 'react';

/** A terminal-style install line with click-to-copy. */
export function CopyCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copycmd"
      aria-label={`Copy command: ${cmd}`}
      onClick={() => {
        navigator.clipboard?.writeText(cmd).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
    >
      <span className="cc-cmd"><span className="cc-prompt">$</span> {cmd}</span>
      <span className={copied ? 'cc-label cc-ok' : 'cc-label'}>{copied ? '✓ copied' : 'copy'}</span>
    </button>
  );
}
