'use client';

import { HardDrive, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { cn } from '@/lib/utils';
import { type LegacyMachine } from '@/hooks/legacy/use-legacy-machine-migration';

// Plain-language phase labels for the in-flight migration steps.
const PHASE_LABEL: Record<string, string> = {
  extract: 'Reading machine',
  repo: 'Setting up project',
  push: 'Bringing over files & agents',
  db: 'Finishing up',
  done: 'Finishing up',
};

/**
 * A legacy Kortix machine rendered as a project card so it sits in the same
 * grid and blends in with real projects — the only difference is a status
 * badge that tells you it still has to be migrated. Clicking the card runs
 * the primary action for its state: migrate, retry, or open the new project.
 */
export function LegacyMachineCard({
  machine,
  starting,
  onMigrate,
  onOpenProject,
}: {
  machine: LegacyMachine;
  starting: boolean;
  onMigrate: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const migration = machine.migration;
  const busy = starting || migration?.status === 'running' || migration?.status === 'planned';
  const done = migration?.status === 'completed';
  const failed = migration?.status === 'failed';
  const providerLabel = machine.provider.charAt(0).toUpperCase() + machine.provider.slice(1);

  // The card's primary click action depends on where the machine is in its
  // migration lifecycle. While busy or when it can't be migrated, the card is
  // inert (no hover, no click).
  let onClick: (() => void) | null = null;
  if (done && migration?.project_id) onClick = () => onOpenProject(migration.project_id!);
  else if (!busy && machine.migratable) onClick = onMigrate;
  const interactive = !!onClick;

  const badge = busy ? (
    <Badge variant="info" size="sm" className="gap-1">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      Migrating
    </Badge>
  ) : done ? (
    <Badge variant="success" size="sm">Migrated</Badge>
  ) : failed ? (
    <Badge variant="warning" size="sm">Migration failed</Badge>
  ) : machine.migratable ? (
    <Badge variant="warning" size="sm">Must be migrated</Badge>
  ) : (
    <Badge variant="muted" size="sm">Can&apos;t migrate</Badge>
  );

  let subtitle: string;
  if (busy && migration) {
    subtitle = `${PHASE_LABEL[migration.phase ?? ''] ?? 'Migrating'}${
      migration.step ? ` (${migration.step}/${migration.total_steps})` : ''
    }`;
  } else if (busy) {
    subtitle = 'Starting migration';
  } else if (failed && migration?.error) {
    subtitle = migration.error;
  } else if (done) {
    subtitle = `${providerLabel} · open project`;
  } else {
    subtitle = providerLabel;
  }

  const body = (
    <div className="flex w-full items-center gap-3">
      <EntityAvatar icon={HardDrive} size="lg" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold leading-tight text-foreground">
          {machine.name}
        </h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {badge}
          <span
            className={cn(
              'truncate text-xs',
              failed ? 'text-destructive/80' : 'text-muted-foreground',
            )}
            title={failed && migration?.error ? migration.error : undefined}
          >
            {subtitle}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border border-border/60 bg-card transition-all duration-150',
        interactive &&
          'hover:border-foreground/30 hover:bg-muted/30 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
      )}
    >
      {interactive ? (
        <button
          type="button"
          onClick={onClick!}
          className="flex flex-1 cursor-pointer flex-col items-start gap-4 rounded-2xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {body}
        </button>
      ) : (
        <div
          className="flex flex-1 flex-col items-start gap-4 p-5 text-left"
          title={!machine.migratable ? 'Only your most recent machines can be migrated.' : undefined}
        >
          {body}
        </div>
      )}
    </div>
  );
}
