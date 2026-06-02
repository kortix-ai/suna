'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { getWarmPoolStatus, updateWarmPool, type KortixProject } from '@/lib/projects-client';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

const MAX_SIZE = 25;

/**
 * Customize → Sandbox → Warm pool. Keeps N pre-booted sandboxes ready so a new
 * session opens instantly instead of cold-booting (~6s). Boxes are only held
 * while a user is actively in the project, then released. Hidden unless the
 * platform feature flag is on (project.warm_pool_available).
 */
export function WarmPoolCard({
  project,
  projectId,
  canManage,
}: {
  project: KortixProject | undefined;
  projectId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const serverEnabled = project?.warm_pool?.enabled ?? true;
  const serverSize = project?.warm_pool?.size ?? 2;

  const [enabled, setEnabled] = useState(serverEnabled);
  const [size, setSize] = useState(serverSize);

  // Re-sync when the server value changes (e.g. another tab, or first load).
  useEffect(() => { setEnabled(serverEnabled); }, [serverEnabled]);
  useEffect(() => { setSize(serverSize); }, [serverSize]);

  const save = useMutation({
    mutationFn: (input: { enabled?: boolean; size?: number }) => updateWarmPool(projectId, input),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['project', projectId] }); },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update warm pool');
      // Roll back optimistic UI to the server truth.
      setEnabled(serverEnabled);
      setSize(serverSize);
    },
  });

  // Live pool status (ready / warming counts), polled while the card is open
  // and the pool is on. Polling also doubles as a presence signal.
  const status = useQuery({
    queryKey: ['warm-pool-status', projectId],
    queryFn: () => getWarmPoolStatus(projectId),
    enabled: !!project?.warm_pool_available && enabled,
    refetchInterval: 4000,
    staleTime: 0,
  });

  if (!project?.warm_pool_available) return null;

  const commit = (next: { enabled?: boolean; size?: number }) => {
    if (!canManage) return;
    save.mutate(next);
  };

  const setSizeClamped = (n: number) => {
    const clamped = Math.max(0, Math.min(MAX_SIZE, n));
    setSize(clamped);
    commit({ size: clamped });
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Zap className="size-4 text-muted-foreground" />
        <label className="text-xs font-medium text-muted-foreground">Warm pool</label>
      </div>
      <div className="divide-y rounded-2xl border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Keep sandboxes warm</div>
            <div className="text-xs text-muted-foreground">
              Pre-boot sandboxes while you&apos;re in the project so new sessions open instantly instead of
              cold-starting. Released automatically when you leave.
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={!canManage || save.isPending}
            onCheckedChange={(v) => { setEnabled(v); commit({ enabled: v }); }}
          />
        </div>

        {enabled && (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Ready sandboxes</div>
              <div className="text-xs text-muted-foreground">
                How many to keep warm and ready to claim ({0}–{MAX_SIZE}).
              </div>
              <div className="mt-1 text-xs text-amber-600 dark:text-amber-500/90">
                Each ready sandbox runs continuously and uses compute (billed to your
                credits) — that&apos;s the trade for instant sessions. Kept low by default
                to preserve credits; raise it for more speed.
              </div>
              {status.data && (
                <div className="mt-1.5 flex items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-500">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {status.data.ready} ready
                  </span>
                  {status.data.warming > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                      {status.data.warming} warming…
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={!canManage || save.isPending || size <= 0}
                onClick={() => setSizeClamped(size - 1)}
                aria-label="Decrease"
              >
                <Minus className="size-4" />
              </Button>
              <span className="w-6 text-center text-sm font-medium tabular-nums">{size}</span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={!canManage || save.isPending || size >= MAX_SIZE}
                onClick={() => setSizeClamped(size + 1)}
                aria-label="Increase"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
