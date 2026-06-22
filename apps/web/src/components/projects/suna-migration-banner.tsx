'use client';

import { Button } from '@/components/ui/button';
import { useStartSunaMigration, useSunaMigration } from '@/hooks/legacy/use-suna-migration';
import { useQueryClient } from '@tanstack/react-query';
import { DangerTriangle as AlertTriangle, ArrowRight, Spinner as Loader2, Sparkles } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

const PHASE_LABEL: Record<string, string> = {
  extract: 'Recovering your files',
  repo: 'Setting up your project',
  push: 'Setting up your project',
  db: 'Restoring your chats',
  done: 'Finishing up',
};

/**
 * Shown ONLY for OG Suna users with old projects to restore. One click migrates
 * all their old chats + files into a single new project; the banner shows
 * progress while it runs and disappears once it's done (eligibility flips false).
 */
export function SunaMigrationBanner({ accountId }: { accountId?: string | null }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { data } = useSunaMigration(accountId);
  const start = useStartSunaMigration(accountId);
  const queryClient = useQueryClient();

  const migration = data?.migration ?? null;

  // When the migration flips to completed, refetch the projects list so the new
  // project shows up without a manual refresh.
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    const s = migration?.status ?? null;
    if (s === 'completed' && prevStatus.current && prevStatus.current !== 'completed') {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
    prevStatus.current = s;
  }, [migration?.status, queryClient]);
  const busy =
    start.isPending || migration?.status === 'running' || migration?.status === 'planned';
  const failed = migration?.status === 'failed';

  // Hide unless there's something to do: eligible to start, in-flight, or failed.
  if (!busy && !failed && !data?.eligible) return null;

  return (
    <div className="border-primary/20 bg-primary/5 flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        {failed ? (
          <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
        ) : (
          <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {busy
              ? 'Restoring your previous projects…'
              : failed
                ? 'We hit a snag restoring your projects'
                : 'Bring your previous projects over'}
          </p>
          <p className="text-muted-foreground text-xs">
            {busy
              ? `${PHASE_LABEL[migration?.phase ?? ''] ?? 'Working'}${migration?.step ? ` (${migration.step}/${migration.total_steps})` : ''}`
              : failed
                ? (migration?.error ?? 'Try again, or contact support if it keeps happening.')
                : 'Your old chats and files are restored into one new project. Takes a few minutes.'}
          </p>
        </div>
      </div>

      {busy ? (
        <Button size="sm" disabled className="shrink-0">
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          {tI18nHardcoded.raw('autoComponentsProjectsSunaMigrationBannerJsxTextRestoringc3690c1d')}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => start.mutate({})}
          disabled={start.isPending}
          className="shrink-0"
        >
          {failed ? 'Retry' : 'Restore my projects'}
          <ArrowRight className="ml-1.5 size-3.5" />
        </Button>
      )}
    </div>
  );
}
