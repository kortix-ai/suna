'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';
import { ArrowSquareOutIcon, WarningIcon } from '@phosphor-icons/react';
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
  const access = sessionAccessMeta(session);
  const fields = sessionDetailFields(session, formatted);
  const href = `/workspaces/${projectId}/sessions/${session.session_id}`;

  return (
    <div className="space-y-5 px-4 py-5">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <DetailItem key={field.label} {...field} />
        ))}
      </dl>

      {session.error ? (
        <InfoBanner tone="destructive" icon={WarningIcon} title="Session error">
          <span className="wrap-break-word">{session.error}</span>
        </InfoBanner>
      ) : null}

      {session.deleted_at ? (
        <InfoBanner tone="neutral" title="Soft-deleted session">
          <span>
            Deleted {formatted.deleted ?? 'at an unknown time'}
            {session.deleted_by ? ` by ${session.deleted_by}` : ''}. The durable record stays here
            for investigation.
          </span>
        </InfoBanner>
      ) : session.can_access === false ? (
        <InfoBanner tone="neutral" title="Metadata-only access">
          You can inspect this record, but the owner has not shared the session content with you.
        </InfoBanner>
      ) : null}

      {access.canOpen ? (
        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" size="sm" asChild>
            <Link href={href}>
              Open session
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
