'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { InfoIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useTranslations } from '@/i18n/use-translations';

const DOCS_HREF = '/docs/connect/connectors#connectors-connections-and-accounts';

/** The ⓘ beside "Accounts": what an account is, and who can use each kind. */
export function AccountInfo({ projectId, displayName }: { projectId: string; displayName: string }) {
  const t = useTranslations('connectorPages');
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectDetailQuery.data?.project?.name ?? '';

  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t('accountInfoLabel')}
        >
          <InfoIcon className="size-4" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 space-y-2 p-4">
        <p className="text-foreground text-sm font-medium">{t('accountInfoTitle')}</p>
        <p className="text-muted-foreground text-xs text-pretty">
          {t('accountInfoBody', { name: displayName })}
        </p>
        <ul className="text-muted-foreground space-y-1 text-xs">
          <li>{t('accountInfoOnlyYou')}</li>
          <li>
            {projectName
              ? t('accountInfoEveryone', { project: projectName })
              : t('accountInfoEveryoneNoProject')}
          </li>
          <li>{t('accountInfoDefault')}</li>
        </ul>
        <Link
          href={DOCS_HREF}
          target="_blank"
          rel="noreferrer"
          className="text-foreground block text-xs font-medium underline underline-offset-2"
        >
          {t('accountInfoDocs')}
        </Link>
      </HoverCardContent>
    </HoverCard>
  );
}
