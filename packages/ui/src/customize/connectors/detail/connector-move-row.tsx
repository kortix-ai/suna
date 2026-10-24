'use client';

import { listConnectorMoves, moveConnector, type AdminConnector } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import Loading from '../../../primitives/loading';
import { errorToast, successToast } from '../../../primitives/toast';
import { startDiscoveredSignIn } from '../../sections/connector-oauth2-start';
import { useTranslations } from '../../../i18n';

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
 * A Pipedream connector in a `connectors_v2` project: Kortix retires Pipedream.
 * With a Kortix app for it, the row moves the connector there: the person signs
 * in once, and the connector switches when the sign-in completes (it keeps its
 * slug). Without one, it says the connector stays on Pipedream.
 *
 * A Composio connector is a supported way to connect. Its row appears only when
 * the app also has its own MCP server, and offers the switch as an option.
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
  const composio = move.provider === 'composio';
  // A Composio connector with no MCP server of its own: nothing to offer.
  if (composio && !move.to) return null;

  const provider = composio ? 'Composio' : 'Pipedream';
  // The other accounts hold logins of the old provider, which no Kortix app accepts.
  const others = Math.max(0, move.accounts - 1);
  const start = () => (others > 0 ? setConfirming(true) : run.mutate());
  return (
    <>
      <ConnectorNoticeRow
        title={
          composio && move.to
            ? t('moveComposioTitle', { app: move.to.name })
            : move.to
              ? t('moveTitle', { app: move.to.name, provider })
              : t('moveNoneTitle', { name: displayName, provider })
        }
        detail={
          <p className="text-muted-foreground text-xs text-pretty">
            {composio && move.to
              ? t('moveComposioBody', { app: move.to.name, slug: connector.slug })
              : move.to
                ? t('moveBody', { app: move.to.name, slug: connector.slug, provider })
                : t('moveNoneBody', { name: displayName, provider })}
          </p>
        }
      >
        {move.to && canWrite ? (
          <Button
            size="sm"
            variant={composio ? 'secondary' : 'default'}
            className="gap-1.5"
            onClick={start}
            disabled={run.isPending}
          >
            {run.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {move.signed_in ? t('moveFinishAction') : composio ? t('moveComposioAction') : t('moveAction')}
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
