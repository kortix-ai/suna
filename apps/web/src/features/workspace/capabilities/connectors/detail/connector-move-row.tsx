'use client';

import { listConnectorMoves, moveConnector, type AdminConnector } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { startDiscoveredSignIn } from '@/features/workspace/customize/sections/connector-oauth2-start';
import { useTranslations } from '@/i18n/use-translations';

import { ConnectorNoticeRow } from './connector-notice-view';

export const connectorMovesQueryKey = (projectId: string) =>
  ['connector-moves', projectId] as const;

/** The move of a Pipedream or Composio connector in a `connectors_v2` project, or undefined. */
export function useConnectorMove(projectId: string, connector: AdminConnector) {
  const enabled =
    useFeatureFlag(projectId, 'connectors_v2').enabled &&
    (connector.provider === 'pipedream' || connector.provider === 'composio');
  const moves = useQuery({
    queryKey: connectorMovesQueryKey(projectId),
    queryFn: () => listConnectorMoves(projectId),
    enabled,
  });
  return enabled ? moves.data?.find((candidate) => candidate.slug === connector.slug) : undefined;
}

/**
 * A Pipedream or Composio connector in a `connectors_v2` project: Kortix retires
 * both. With a Kortix app for it, the row moves the connector there: the person
 * signs in once, and the connector switches when the sign-in completes (it keeps
 * its slug). Without one, it says the connector stays on its provider.
 */
export function ConnectorMoveRow({
  projectId,
  connector,
  displayName,
  canWrite,
  onMoved,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  onMoved: () => void;
}) {
  const t = useTranslations('connectorPages');
  const move = useConnectorMove(projectId, connector);
  const [confirming, setConfirming] = useState(false);
  const run = useMutation({
    mutationFn: async () => {
      const result = await moveConnector(projectId, connector.slug);
      if (result.status === 'moved') return 'moved' as const;
      // The same sign-in Install runs. The browser returns here, and the
      // connector has switched by then.
      const url = result.connection_id
        ? await startDiscoveredSignIn(projectId, result.connection_id, window.location.href)
        : null;
      if (!url) throw new Error(t('moveNoSignIn', { app: result.to?.name ?? displayName }));
      window.location.assign(url);
      return 'sign_in' as const;
    },
    onSuccess: (outcome) => {
      if (outcome !== 'moved') return;
      successToast(t('moveDone', { name: displayName }));
      onMoved();
    },
    onError: (error: Error) => errorToast(error.message),
  });
  if (!move) return null;

  const provider = move.provider === 'composio' ? 'Composio' : 'Pipedream';
  // The other accounts hold logins of the old provider, which no Kortix app accepts.
  const others = Math.max(0, move.accounts - 1);
  const start = () => (others > 0 ? setConfirming(true) : run.mutate());
  return (
    <>
      <ConnectorNoticeRow
        title={
          move.to
            ? t('moveTitle', { app: move.to.name, provider })
            : t('moveNoneTitle', { name: displayName, provider })
        }
        detail={
          <p className="text-muted-foreground text-xs text-pretty">
            {move.to
              ? t('moveBody', { app: move.to.name, slug: connector.slug, provider })
              : t('moveNoneBody', { name: displayName, provider })}
          </p>
        }
      >
        {move.to && canWrite ? (
          <Button size="sm" className="gap-1.5" onClick={start} disabled={run.isPending}>
            {run.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {move.signed_in ? t('moveFinishAction') : t('moveAction')}
          </Button>
        ) : null}
      </ConnectorNoticeRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('moveConfirmTitle', { app: move.to?.name ?? displayName })}
        description={t('moveConfirmBody', { count: others, provider })}
        confirmLabel={t('moveAction')}
        isPending={run.isPending}
        onConfirm={() => {
          setConfirming(false);
          run.mutate();
        }}
      />
    </>
  );
}
