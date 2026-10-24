'use client';

import type { ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { EmptyState } from '../../primitives/empty-state';

/** A layer with no pages: what memory is, and "Remember this…" for a writer. */
export function MemoryEmpty({ kind, action }: { kind: 'company' | 'channel' | 'dm'; action?: ReactNode }) {
  const t = useTranslations('spaces.memory.empty');
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-16">
      <EmptyState
        size="sm"
        title={t(kind === 'dm' ? 'titleDm' : kind === 'company' ? 'titleCompany' : 'title')}
        description={t('description')}
        action={action}
      />
    </div>
  );
}
