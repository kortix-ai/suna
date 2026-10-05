'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';
import { ArrowSquareOutIcon, WarningIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

import {
  sessionAccessMeta,
  sessionDetailFields,
  type SessionDetailField,
} from './project-sessions-helpers';

function DetailItem({ label, value, mono }: SessionDetailField) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={cn(
          'text-foreground text-sm wrap-break-word',
          mono && 'font-mono text-xs tabular-nums',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function SessionDetail({
  projectId,
  session,
  formatted,
}: {
  projectId: string;
  session: ProjectSession;
  formatted: { created: string; updated: string; deleted: string | null };
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const access = sessionAccessMeta(session, tI18nComplete);
  const fields = sessionDetailFields(session, formatted, tI18nComplete);
  const href = `/projects/${projectId}/sessions/${session.session_id}`;

  return (
    <div className="space-y-5 px-4 py-5">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <DetailItem key={field.label} {...field} />
        ))}
      </dl>

      {session.error ? (
        <InfoBanner
          tone="destructive"
          icon={WarningIcon}
          title={tI18nComplete.raw('text650e4f3bbda1')}
        >
          <span className="wrap-break-word">{session.error}</span>
        </InfoBanner>
      ) : null}

      {session.deleted_at ? (
        <InfoBanner tone="neutral" title={tI18nComplete.raw('textfdb73b4a48f2')}>
          <span>
            {tI18nComplete.raw('textb48ff39c2e0f')}{' '}
            {formatted.deleted ?? tI18nComplete.raw('texted8aa125a36b')}
            {session.deleted_by ? ` by ${session.deleted_by}` : ''}
            {tI18nComplete.raw('text78a10fea0bef')}
          </span>
        </InfoBanner>
      ) : session.can_access === false ? (
        <InfoBanner tone="neutral" title={tI18nComplete.raw('text4acf3c9c6c5e')}>
          {tI18nComplete.raw('text1f5bdc1c9cf0')}
        </InfoBanner>
      ) : null}

      {access.canOpen ? (
        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" size="sm" asChild>
            <Link href={href}>
              {tI18nComplete.raw('textb205bb47f81a')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
