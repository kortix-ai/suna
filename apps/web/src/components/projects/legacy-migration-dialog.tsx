'use client';

import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Server,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  useLegacyMachines,
  useStartLegacyMigration,
  type LegacyMachine,
} from '@/hooks/legacy/use-legacy-machine-migration';

const PHASE_LABEL: Record<string, string> = {
  extract: 'Reading machine',
  repo: 'Creating repository',
  push: 'Uploading files & agents',
  db: 'Finalizing project',
  done: 'Finishing up',
};

export function LegacyMigrationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useLegacyMachines({ enabled: open });
  const start = useStartLegacyMigration();
  const machines = data?.sandboxes ?? [];

  const handleMigrate = (sandboxId: string) => {
    start.mutate(sandboxId, {
      onSuccess: () => toast.success('Migration started — this runs in the background'),
      onError: (e: Error) => toast.error(e.message || 'Failed to start migration'),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Migrate legacy machines</DialogTitle>
          <DialogDescription>
            Bring a legacy Kortix machine into the new workspace as a project — your files,
            custom agents and chat history come with it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          {isLoading && (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {isError && (
            <div className="flex flex-col items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <span className="text-destructive">{(error as Error)?.message || 'Failed to load machines'}</span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          )}

          {!isLoading && !isError && machines.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No legacy machines found on this account.
            </div>
          )}

          {machines.map((machine) => (
            <MachineRow
              key={machine.sandbox_id}
              machine={machine}
              starting={start.isPending && start.variables === machine.sandbox_id}
              onMigrate={() => handleMigrate(machine.sandbox_id)}
              onOpenProject={(projectId) => {
                onOpenChange(false);
                router.push(`/projects/${projectId}`);
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MachineRow({
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
  const inFlight = migration?.status === 'running' || migration?.status === 'planned';
  const done = migration?.status === 'completed';
  const failed = migration?.status === 'failed';

  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card p-3">
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          done ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground',
        )}
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : <Server className="h-4 w-4" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{machine.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="uppercase tracking-wide">{machine.provider}</span>
          <span>·</span>
          {inFlight && migration ? (
            <span className="text-foreground">
              {PHASE_LABEL[migration.phase ?? ''] ?? 'Migrating'}
              {migration.step ? ` (${migration.step}/${migration.total_steps})` : ''}
            </span>
          ) : done ? (
            <span className="text-emerald-600">Migrated</span>
          ) : failed ? (
            <span className="text-destructive">Failed</span>
          ) : (
            <span>{machine.status}</span>
          )}
        </div>
        {failed && migration?.error && (
          <div className="mt-1 truncate text-xs text-destructive/80" title={migration.error}>
            {migration.error}
          </div>
        )}
      </div>

      <div className="shrink-0">
        {done && migration?.project_id ? (
          <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenProject(migration.project_id!)}>
            Open <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ) : inFlight ? (
          <Button size="sm" variant="ghost" disabled className="gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Migrating
          </Button>
        ) : machine.migratable ? (
          <Button size="sm" onClick={onMigrate} disabled={starting} className="gap-1.5">
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : failed ? <RotateCcw className="h-3.5 w-3.5" /> : null}
            {failed ? 'Retry' : 'Migrate'}
          </Button>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Only JustAVPS machines can be migrated">
            <AlertCircle className="h-3.5 w-3.5" /> Not migratable
          </span>
        )}
      </div>
    </div>
  );
}
