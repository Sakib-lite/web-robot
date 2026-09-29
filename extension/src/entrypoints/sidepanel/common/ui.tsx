import type { ReactNode } from 'react';

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={open ? 'card-body open' : 'card-body'}>
      <div>{children}</div>
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={open ? 'chevron open' : 'chevron'} width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
