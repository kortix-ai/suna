'use client';

/**
 * The session was refused because a connector it declares has no usable
 * connection — said in the UI, before anything streams.
 *
 * This is the whole point of the pre-flight: the platform knew the answer
 * before the first byte, so the user should never pay for tokens to be told by
 * the agent, mid-turn, that it cannot reach their mailbox. A generic error
 * toast is barely better — it names neither the connector nor anyone who can
 * fix it.
 *
 * The card is deliberately honest about WHICH case it is in. Only a
 * `project`-strategy connector can be unblocked from here (a Quick Connect link
 * this app can mint through its own allow-listed proxy); a `user`-strategy one
 * cannot be, by construction, so it gets a list of what would actually unblock
 * it and no button. A button that leads to a 409 is worse than a sentence that
 * tells the truth.
 */

import { Button } from '@/components/ui/button';
import { CallSnippet } from '@/components/dev/call-snippet';
import Loading from '@/components/ui/loading';
import { useWrapperMode } from '@/app/providers';
import { serverErrorBody } from '@/lib/api-error-body';
import {
  type ConnectorRequirement,
  type RequiredConnector,
  connectorRemedy,
} from '@/lib/connector-required';
import { kortix } from '@/lib/kortix';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, Link2, Plug } from 'lucide-react';

export function ConnectRequiredCard({
  projectId,
  requirement,
  onRetry,
  onDismiss,
}: {
  projectId: string;
  requirement: ConnectorRequirement;
  /** Offered only after the user has been told what to do; never auto-fires. */
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const wrapperMode = useWrapperMode();

  return (
    <div className="rounded-2xl border border-brand/40 bg-brand/5 p-4 text-left">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Plug className="size-4 text-brand" />
        {requirement.connectors.length > 1
          ? 'This session needs connections it does not have'
          : 'This session cannot start yet'}
      </div>

      {requirement.connectors.length === 0 ? (
        // The server refused without naming a connector. Say only what is known
        // rather than inventing one.
        <p className="mt-2 text-sm text-muted-foreground">
          {requirement.message ||
            'It declares a connector with no usable connection, so it was refused before it started.'}
        </p>
      ) : (
        <div className="mt-2 space-y-4">
          {requirement.connectors.map((connector) => (
            <ConnectorRemedyBlock
              key={connector.alias}
              projectId={projectId}
              connector={connector}
              wrapperMode={wrapperMode}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            Try starting it again
          </Button>
        )}
        {onDismiss && (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

function ConnectorRemedyBlock({
  projectId,
  connector,
  wrapperMode,
}: {
  projectId: string;
  connector: RequiredConnector;
  wrapperMode: boolean;
}) {
  const copy = connectorRemedy(connector, { wrapperMode });

  // `POST /projects/{id}/connect-requests` — the same setup-link mint an agent
  // uses to ask a human for a credential. It is a `projects/{id}/…` route, so
  // the wrapper proxy already allows it for a project the caller owns, and no
  // new app route is introduced. It can still legitimately refuse (the
  // deployment has no Pipedream, or the connector is not a Pipedream one), so
  // the refusal is shown verbatim instead of being swallowed into "try again".
  const mint = useMutation({
    mutationFn: () =>
      kortix
        .project(projectId)
        .setupLinks.requestConnector({ slug: connector.alias }),
  });
  const mintError = mint.error
    ? (typeof serverErrorBody(mint.error)?.error === 'string'
        ? String(serverErrorBody(mint.error)?.error)
        : null) ?? 'The connect link could not be created.'
    : null;

  return (
    <div>
      <div className="text-sm font-medium">{copy.headline}</div>
      <p className="mt-0.5 text-sm text-muted-foreground">{copy.explanation}</p>

      {copy.canMintConnectLink ? (
        <div className="mt-2">
          {mint.data ? (
            <div className="space-y-1.5">
              <Button size="sm" variant="secondary" asChild>
                <a href={mint.data.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  Connect {connector.name}
                </a>
              </Button>
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                {mint.data.url}
              </p>
              <p className="text-xs text-muted-foreground">
                Anyone with this link can connect {connector.name} for the whole
                project. It expires on its own — share it only with whoever
                should own that connection.
              </p>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={mint.isPending}
              onClick={() => mint.mutate()}
            >
              {mint.isPending ? (
                <Loading className="size-4" />
              ) : (
                <Link2 className="size-3.5" />
              )}
              Create a connect link
            </Button>
          )}
          {mintError && (
            <p className="mt-1.5 text-xs text-destructive">{mintError}</p>
          )}
          {/* The button is the first remedy; the rest still stand, and matter
              most when the mint refuses. */}
          <UnblockedBy items={copy.unblockedBy.slice(1)} />
          {/* The refusal AND its remedy are the KaaB lesson here — a wrapper
              author needs both the codes to classify and the call that fixes
              the one that can be fixed. */}
          <CallSnippet
            id="connector.connect-link"
            className="mt-2"
            context={{ projectId, connector: connector.alias }}
          />
        </div>
      ) : (
        <UnblockedBy items={copy.unblockedBy} />
      )}
    </div>
  );
}

/**
 * What would actually unblock this session.
 *
 * Listed even where a button exists: the button is one route, and the person
 * looking at this card is often not the person who can take it.
 */
function UnblockedBy({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item} className="flex gap-1.5">
          <span aria-hidden>—</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
