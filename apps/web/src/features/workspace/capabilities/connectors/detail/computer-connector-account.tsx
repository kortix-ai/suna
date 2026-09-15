'use client';

import { createConnector, getConnectorConfig, type AdminConnector } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { ComputerTunnelManager } from '@/features/tunnel/tunnel-overview';

export function normalizeMachineSelection(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ].sort();
}

export function machineSelectionChanged(
  current: readonly unknown[],
  saved: readonly unknown[],
): boolean {
  return (
    JSON.stringify(normalizeMachineSelection(current)) !==
    JSON.stringify(normalizeMachineSelection(saved))
  );
}

export function ComputerConnectorAccount({
  projectId,
  connector,
  canWrite,
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['connector-config', projectId, connector.slug],
    queryFn: () => getConnectorConfig(projectId, connector.slug),
  });
  const savedIds = configQuery.data?.tunnelIds ?? [];
  const [selection, setSelection] = useState<string[] | null>(null);
  const selectedIds = selection ?? savedIds;

  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        slug: connector.slug,
        name: connector.name,
        provider: 'computer',
        tunnel_ids: normalizeMachineSelection(selectedIds),
      }),
    onSuccess: () => {
      successToast(tI18nComplete.raw('texte113af6b6913'));
      setSelection(null);
      void queryClient.invalidateQueries({
        queryKey: ['connector-config', projectId, connector.slug],
      });
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text465e15da7bba')),
  });

  if (configQuery.isLoading) {
    return <Skeleton className="h-96 rounded-md" />;
  }
  if (configQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title={tI18nComplete.raw('textf6d0f6c23cc4')}
        description={(configQuery.error as Error).message}
        action={
          <Button variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
            {tI18nComplete.raw('text942087cc2d41')}
          </Button>
        }
      />
    );
  }

  const dirty = machineSelectionChanged(selectedIds, savedIds);
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>{tI18nComplete.raw('textc9ebef5b7729')}</Label>
        <p className="text-muted-foreground text-xs text-pretty">
          {tI18nComplete.raw('textac6b2a0cfa8e')}
        </p>
      </div>

      <ComputerTunnelManager
        canWrite={canWrite}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelection}
        selectionDisabled={!canWrite || save.isPending}
        visibleIds={canWrite ? undefined : savedIds}
      />

      {canWrite ? (
        <div className="border-border/60 flex justify-end gap-2 border-t pt-4">
          {dirty ? (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => setSelection(null)}
            >
              {tI18nComplete.raw('textdaee7606b339')}
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty || selectedIds.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text79af590ff652')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
