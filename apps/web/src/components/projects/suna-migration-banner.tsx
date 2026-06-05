'use client';

import { ArrowRight, Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSunaMigration, useStartSunaMigration } from '@/hooks/legacy/use-suna-migration';

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
  const { data } = useSunaMigration(accountId);
  const start = useStartSunaMigration(accountId);

  const migration = data?.migration ?? null;
  const busy = start.isPending || migration?.status === 'running' || migration?.status === 'planned';
  const failed = migration?.status === 'failed';

  // Hide unless there's something to do: eligible to start, in-flight, or failed.
  if (!busy && !failed && !data?.eligible) return null;

  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5 min-w-0">
        {failed ? (
          <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
        ) : (
          <Sparkles className="size-4 text-primary mt-0.5 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {busy ? 'Restoring your previous projects…' : failed ? 'We hit a snag restoring your projects' : 'Bring your previous projects over'}
          </p>
          <p className="text-xs text-muted-foreground">
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
          <Loader2 className="size-3.5 animate-spin mr-1.5" />Restoring…
        </Button>
      ) : (
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending} className="shrink-0">
          {failed ? 'Retry' : 'Restore my projects'}
          <ArrowRight className="size-3.5 ml-1.5" />
        </Button>
      )}
    </div>
  );
}
