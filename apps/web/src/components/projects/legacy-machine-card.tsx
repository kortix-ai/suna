'use client';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { type LegacyMachine } from '@/hooks/legacy/use-legacy-machine-migration';
import { cn } from '@/lib/utils';
import Loading from '../ui/loading';

const PHASE_LABEL: Record<string, string> = {
  extract: 'Reading machine',
  repo: 'Setting up project',
  push: 'Bringing over files & agents',
  db: 'Finishing up',
  done: 'Finishing up',
};

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

  let onClick: (() => void) | null = null;
  if (done && migration?.project_id) onClick = () => onOpenProject(migration.project_id!);
  else if (!busy && machine.migratable) onClick = onMigrate;
  const interactive = !!onClick;

  const badge = busy ? (
    <Badge variant="info" size="sm" className="gap-1">
      <Loading className="size-3" />
      Migrating
    </Badge>
  ) : done ? (
    <Badge variant="success" size="sm">
      Migrated
    </Badge>
  ) : failed ? (
    <Badge variant="warning" size="sm">
      Migration failed
    </Badge>
  ) : machine.migratable ? (
    <Badge variant="warning" size="sm">
      Must be migrated
    </Badge>
  ) : (
    <Badge variant="muted" size="sm">
      Can&apos;t migrate
    </Badge>
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
      <EntityAvatar label={machine.name} size="lg" className="bg-background" />
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-foreground truncate text-sm leading-tight font-semibold">
          {machine.name}
        </h3>
        <p
          className={cn(
            'truncate text-xs',
            failed ? 'text-destructive/80' : 'text-muted-foreground',
          )}
          title={failed && migration?.error ? migration.error : undefined}
        >
          {subtitle}
        </p>
      </div>
    </div>
  );

  return (
    <Card className="group bg-secondary/80 relative p-0">
      {interactive ? (
        <button type="button" onClick={onClick!} className="cursor-pointer px-5 py-4 text-left">
          {body}
        </button>
      ) : (
        <div
          className="px-5 py-4 text-left"
          title={
            !machine.migratable ? 'Only your most recent machines can be migrated.' : undefined
          }
        >
          {body}
        </div>
      )}

      <div className="absolute top-3 right-3">{badge}</div>
    </Card>
  );
}
