import type { ReactNode } from 'react';
export const DETAIL_PAGE_COLUMN = 'mx-auto w-full max-w-5xl space-y-6 px-4 py-10 pb-20 lg:py-14';
export function DetailPageShell({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy || undefined}>
      <div className={DETAIL_PAGE_COLUMN}>{children}</div>
    </div>
  );
}
