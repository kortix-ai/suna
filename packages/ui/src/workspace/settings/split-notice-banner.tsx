'use client';

/**
 * The split notice (design.md C9): for 30 days after a legacy account's
 * workspaces became their own workspaces, `GET /v1/workspaces/:id` carries
 * `split_notice`. The workspace home and Settings › General say what changed:
 * a moved workspace has its own people, billing and settings now; the keeper
 * lost the others. A viewer can dismiss it; the dismissal stays in this
 * browser only.
 */

import { useWorkspace } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { InfoBanner } from '../../primitives/info-banner';
import { formatWorkspaceDate } from '../project-selector/project-selector-model';

/** `split_notice` on a served workspace (C9). Absent on an older API. */
export interface WorkspaceSplitNotice {
  role: 'keeper' | 'moved';
  source_name: string;
  completed_at: string;
  billing: 'free' | 'comped' | null;
  comped_until: string | null;
}

export function splitNoticeOf(workspace: unknown): WorkspaceSplitNotice | null {
  const notice = (workspace as { split_notice?: WorkspaceSplitNotice | null } | null | undefined)?.split_notice;
  return notice && (notice.role === 'keeper' || notice.role === 'moved') ? notice : null;
}

const DISMISS_KEY = (workspaceId: string) => `kortix.splitNotice.dismissed.${workspaceId}`;

function readDismissed(workspaceId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY(workspaceId)) === '1';
  } catch {
    return false;
  }
}

export function SplitNoticeBanner({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const t = useTranslations('workspaces.splitNotice');
  const locale = useLocale();
  const workspace = useWorkspace(workspaceId);
  const notice = splitNoticeOf(workspace.data);
  const [dismissed, setDismissed] = useState(() => (typeof window === 'undefined' ? false : readDismissed(workspaceId)));
  if (!notice || dismissed) return null;

  const date = formatWorkspaceDate(notice.completed_at, locale);
  const body =
    notice.role === 'moved'
      ? t('movedBody', { source: notice.source_name, date })
      : t('keeperBody', { source: notice.source_name, date });
  const billing =
    notice.role !== 'moved'
      ? null
      : notice.billing === 'comped'
        ? t('billingComped', { date: formatWorkspaceDate(notice.comped_until, locale) })
        : notice.billing === 'free'
          ? t('billingFree')
          : null;

  return (
    <InfoBanner
      tone="info"
      title={notice.role === 'moved' ? t('movedTitle') : t('keeperTitle')}
      className={className}
      data-testid="split-notice"
      action={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('dismiss')}
          onClick={() => {
            try {
              window.localStorage.setItem(DISMISS_KEY(workspaceId), '1');
            } catch {
              // Private mode: the banner hides for this view only.
            }
            setDismissed(true);
          }}
        >
          <XIcon className="size-3.5" />
        </Button>
      }
    >
      {body}
      {billing ? ` ${billing}` : null}
    </InfoBanner>
  );
}
