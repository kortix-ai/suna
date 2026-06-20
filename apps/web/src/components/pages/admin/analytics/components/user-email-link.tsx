'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import type { UserEmailLinkProps } from '../types';

export function UserEmailLink({ email, onUserClick, className = '' }: UserEmailLinkProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (!email) {
    return <span className="text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsUserEmailLink.line8JsxTextUnknownUser')}</span>;
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onUserClick(email);
      }}
      className={cn('text-primary hover:underline hover:text-primary/80 transition-colors text-left', className)}
    >
      {email}
    </button>
  );
}
