'use client';

/**
 * The turn was refused because a connector it needs has nothing connected —
 * said inline, under the message that triggered it.
 *
 * This replaces a bare one-line pill. The refusal is the one failure in a
 * session with an obvious remedy and a button that performs it, so it gets a
 * card with the connector named and the action attached, rather than a sentence
 * the user has to translate into "go find the connectors screen".
 *
 * The button opens the SAME gate a connector-blocked session create uses
 * (`connector-gate-store`), because that dialog already owns the Pipedream
 * one-click flow, polls for the connection, and re-runs the refused work. Two
 * implementations of "connect this app" would drift, and the second one would
 * be the one nobody tests.
 *
 * Nothing here auto-opens. A modal that appears on its own steals focus from a
 * user who may be mid-sentence; the card waits to be clicked.
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useConnectorGateStore } from '@/stores/connector-gate-store';
import type { KortixSendError, KortixSendErrorConnector } from '@kortix/sdk/react';
import { PlugIcon as Plug } from '@phosphor-icons/react';

export interface ConnectorNoticeCopy {
  /** "Gmail" · "Gmail and Slack" · "Gmail, Slack and Notion". */
  label: string;
  /**
   * The connectors a button here could actually connect.
   *
   * `user` strategy means the connection must belong to the account the session
   * RUNS AS. Nobody else can supply it, so offering a button would be offering a
   * 409 — the card says who can unblock it instead.
   */
  connectable: KortixSendErrorConnector[];
}

/** Pure so the copy and the button decision are testable without a DOM. */
export function connectorNoticeCopy(
  connectors: readonly KortixSendErrorConnector[],
): ConnectorNoticeCopy {
  const names = connectors.map((connector) => connector.name);
  return {
    label:
      names.length <= 1
        ? (names[0] ?? '')
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`,
    connectable: connectors.filter(
      (connector) => connector.authorization_strategy === 'project',
    ),
  };
}

export function ConnectorRequiredNotice({
  error,
  projectId,
  resend,
  className,
}: {
  error: KortixSendError | null | undefined;
  projectId: string | undefined;
  /** Re-send the refused prompt once every connector is connected. */
  resend: (() => void) | undefined;
  className?: string;
}) {
  const openConnectorGate = useConnectorGateStore((state) => state.openConnectorGate);

  const connectors = error?.kind === 'connector' ? error.connectors : undefined;
  if (!connectors?.length || !projectId) return null;

  const names = connectors.map((connector) => connector.name);
  const { label, connectable } = connectorNoticeCopy(connectors);

  return (
    <div className={cn('bg-popover rounded-md border px-4 py-3.5', className)}>
      <div className="flex items-start gap-3">
        <div className="bg-kortix-orange/10 grid size-9 shrink-0 place-items-center rounded-sm">
          <Plug className="text-kortix-orange size-4" weight="bold" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            Connect {label} to continue
          </p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            This session needs {label}, and nothing is connected to{' '}
            {names.length === 1 ? 'it' : 'them'} yet. Nothing has run and nothing was charged —
            connect{' '}
            {names.length === 1 ? 'the account' : 'the accounts'} and your message is sent again.
          </p>

          {connectable.length > 0 ? (
            <Button
              size="sm"
              className="mt-3 gap-1.5"
              onClick={() =>
                openConnectorGate({
                  projectId,
                  connectorConnections: connectors,
                  retry: () => resend?.(),
                })
              }
            >
              <Plug className="size-3.5 shrink-0" weight="bold" />
              {connectable.length === 1 ? `Connect ${connectable[0].name}` : 'Connect accounts'}
            </Button>
          ) : (
            // Every one is `user` strategy: this app cannot mint a link that
            // would help, and a dead button is worse than a straight sentence.
            <p className="text-muted-foreground mt-2 text-xs text-pretty">
              {label} authorizes one account at a time, so it has to be connected by the account
              this session runs as.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
