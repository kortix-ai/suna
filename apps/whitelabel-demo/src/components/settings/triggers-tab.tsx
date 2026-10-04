'use client';

/**
 * The Automations tab: pause/resume, the add form, and the trigger list.
 * The form owns its create; each row owns its presentation; fire/remove stay
 * here so their pending state spans every row, as before.
 */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import type { ProjectTrigger } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { toast } from 'sonner';
import { AddTriggerForm } from './triggers/add-trigger-form';
import { TriggerRow } from './triggers/trigger-row';

export function TriggersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.triggers(projectId) });

  const triggers = useQuery({
    queryKey: qk.triggers(projectId),
    queryFn: () => kortix.project(projectId).triggers.list(),
  });

  const items: ProjectTrigger[] = triggers.data?.triggers ?? [];
  const paused: boolean = Boolean(triggers.data?.triggers_paused);

  const setActivation = useMutation({
    mutationFn: (next: boolean) => kortix.project(projectId).triggers.setActivation(next),
    onSuccess: (_res, next) => {
      refresh();
      toast.success(next ? 'All triggers paused' : 'All triggers resumed');
    },
    onError: () => toast.error('Could not change activation'),
  });

  const fire = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).triggers.fire(slug),
    onSuccess: (res) => {
      toast.success(`Trigger ${res.status}`);
    },
    onError: () => toast.error('Could not fire trigger'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).triggers.remove(slug),
    onSuccess: () => {
      refresh();
      toast.success('Trigger deleted');
    },
    onError: () => toast.error('Could not delete trigger'),
  });

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Zap className="size-4 text-muted-foreground" /> Automations
            </div>
            <p className="text-xs text-muted-foreground">
              {paused
                ? 'All triggers are paused — nothing auto-runs.'
                : 'Triggers run automatically on schedule or webhook.'}
            </p>
          </div>
          <Button
            variant={paused ? 'default' : 'outline'}
            size="sm"
            disabled={setActivation.isPending}
            onClick={() => setActivation.mutate(!paused)}
          >
            {setActivation.isPending && <Loading className="size-4" />}
            {paused ? 'Resume all' : 'Pause all'}
          </Button>
        </div>
      </Card>

      <AddTriggerForm projectId={projectId} />

      <Card className="divide-y divide-border p-0">
        {triggers.isLoading && (
          <div className="p-4">
            <Skeleton className="h-5 w-44" />
          </div>
        )}
        {triggers.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No triggers yet.</div>
        )}
        {items.map((t, i) => {
          const slug = String(t.slug ?? t.name ?? i);
          return (
            <TriggerRow
              key={slug}
              projectId={projectId}
              trigger={t}
              index={i}
              paused={paused}
              firing={fire.isPending}
              removing={remove.isPending}
              onFire={() => fire.mutate(slug)}
              onRemove={() => remove.mutate(slug)}
            />
          );
        })}
      </Card>
    </div>
  );
}
