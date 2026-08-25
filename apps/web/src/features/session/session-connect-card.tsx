'use client';

/**
 * "Connect Gmail" — a button, in the session, for the connector the agent just
 * asked about.
 *
 * Before this the agent posted a raw `https://connect.composio.dev/link/…` into
 * the transcript and stopped, so the flow was: copy the URL, open a tab, sign
 * in, come back, type "done". The link also expires, so a slow round trip meant
 * the agent minted a second one and the user did it twice.
 *
 * The button runs the SAME popup-and-poll flow the connectors screen uses
 * (`runConnectLinkFlow`), and finalizing tells the agent the account landed, so
 * nobody types "done". Shaped like `ConnectorRequiredNotice` on purpose — the
 * two cards answer the same question ("something needs connecting") and must
 * not look like two different features.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  useSessionConnectRequests,
  useSessionConnectorConnect,
} from '@/hooks/connectors/use-session-connect-requests';
import { cn } from '@/lib/utils';
import { PlugIcon } from '@phosphor-icons/react';

import { sessionConnectPrompt } from './session-connect-requests';

export function SessionConnectCard({
  projectId,
  sessionId,
  className,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  className?: string;
}) {
  const { data } = useSessionConnectRequests(projectId, sessionId);
  const connect = useSessionConnectorConnect(projectId ?? '', sessionId ?? '');
  const { pending, label } = sessionConnectPrompt(data);

  if (!projectId || !sessionId || pending.length === 0) return null;

  return (
    <div className={cn('bg-popover rounded-md border px-4 py-3.5', className)}>
      <div className="flex items-start gap-3">
        <div className="bg-kortix-orange/10 grid size-9 shrink-0 place-items-center rounded-sm">
          <PlugIcon className="text-kortix-orange size-4" weight="fill" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">Connect {label} to continue</p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            The agent is waiting on {pending.length === 1 ? 'this account' : 'these accounts'}.
            Sign in through the popup — it picks the task back up on its own.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {pending.map((request) => (
              <Button
                key={request.slug}
                size="sm"
                className="gap-1.5"
                // One button at a time: `runConnectLinkFlow` opens the popup
                // before its first await to keep the browser's user activation,
                // and two of those in flight would fight over the same window.
                disabled={connect.isPending}
                onClick={() => connect.mutate(request.slug)}
              >
                {connect.isPending && connect.variables === request.slug ? (
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <PlugIcon className="size-3.5 shrink-0" />
                )}
                Connect {request.app || request.slug}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
