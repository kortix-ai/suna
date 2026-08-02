'use client';

import type { AdminConnector } from '@kortix/sdk';
import { KeyIcon, LockIcon, MonitorIcon, UsersIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { useCustomizeStore } from '@/stores/customize-store';

import {
  describeConnectorActionCounts,
  summarizeConnectorActions,
} from './connector-action-summary';

export interface RungOverviewProps {
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  /** `authorizationStrategy === 'project' && secretSet` — only ever true under
   *  project authorization. A user-strategy connector's per-person state lives
   *  on member profiles this rung does not fetch; the Accounts rung owns it. */
  connected: boolean;
  strategyUpdating: boolean;
  reconnectPending: boolean;
  onReconnect: () => void;
  onSetCredential: () => void;
  /** Closes the modal — needed for capability #13's cross-surface jump. */
  onClose: () => void;
}

/**
 * Overview — capabilities #5, #6 and #13, on the conditions the shipped panel
 * (`connectors-view.tsx`) uses line for line:
 *
 * - #5 `connectors-view.tsx:1593`: `authSecret && !connected && !isChannel &&
 *   usesProjectAuthorization`.
 * - #6 `connectors-view.tsx:1617`: `authSecret && !isPipedream && !isChannel
 *   && !isComputer && !usesProjectAuthorization`. Deliberately NOT gated on
 *   `canWrite` — a member always manages their own credential.
 * - #13 `connectors-view.tsx:1571`: `provider === 'computer'`.
 *
 * Below the CTA/status half, a "What it does" summary is derived only from
 * `connector.actions` — a read/write count plus up to four representative
 * names, never invented copy. It renders nothing for zero actions (the
 * `verify-api` fixture) rather than an empty shell or a "0 tools" line.
 *
 * No Links section: `AdminConnector` carries no URL-shaped field (only
 * `iconUrl`, an image asset, not a page to visit — see
 * `packages/sdk/src/core/rest/projects-client/connectors.ts:20`), so there is
 * nothing on this record a Links block could show without fabricating one.
 */
export function RungOverview({
  connector,
  displayName,
  canWrite,
  connected,
  strategyUpdating,
  reconnectPending,
  onReconnect,
  onSetCredential,
  onClose,
}: RungOverviewProps) {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';

  const showProjectConnect =
    Boolean(connector.authSecret) && !connected && !isChannel && usesProjectAuthorization;
  const showPersonalConnect =
    Boolean(connector.authSecret) &&
    !isPipedream &&
    !isChannel &&
    !isComputer &&
    !usesProjectAuthorization;
  // Nothing to act on — say where the connector stands instead of an empty rung.
  const showStatus = !showProjectConnect && !showPersonalConnect && !isComputer;

  const summary = summarizeConnectorActions(connector.actions);

  return (
    <div className="space-y-4">
      {/* Capability #13. Computers stayed in the Customize overlay when
          Connectors, Skills and Commands graduated to routes, so this is a
          deliberate cross-surface jump: close the modal, then open the
          overlay on that section. */}
      {isComputer ? (
        <InfoBanner
          tone="info"
          icon={MonitorIcon}
          title={`${displayName} is managed in Computers`}
          action={
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                onClose();
                openCustomize('computers');
              }}
            >
              <MonitorIcon className="size-4 shrink-0" />
              Open Computers
            </Button>
          }
        >
          Connect a machine, and grant or revoke per-capability access, in the Computers tab. Here
          you control who can use it and review its tools.
        </InfoBanner>
      ) : null}

      {/* Capability #5. Project-owned profiles accept only project-managed
          authorizations. */}
      {showProjectConnect ? (
        <InfoBanner
          tone="info"
          icon={UsersIcon}
          title={`Connect ${displayName} for everyone`}
          action={
            canWrite ? (
              <Button
                size="lg"
                className="h-11 shrink-0 gap-2 px-5 font-semibold"
                onClick={() => (isPipedream ? onReconnect() : onSetCredential())}
                disabled={strategyUpdating || (isPipedream && reconnectPending)}
              >
                {isPipedream && reconnectPending ? <Loading className="size-4 shrink-0" /> : null}
                {isPipedream ? 'Connect for everyone' : 'Add a shared credential'}
              </Button>
            ) : undefined
          }
        >
          One account the whole project uses — agents and triggers run on it.
        </InfoBanner>
      ) : null}

      {/* Capability #6. Deliberately NOT gated on `canWrite`: a member always
          manages their own private credential. */}
      {showPersonalConnect ? (
        <InfoBanner
          tone="info"
          icon={LockIcon}
          title={`Connect ${displayName} for your sessions`}
          action={
            <Button
              size="lg"
              className="h-11 shrink-0 gap-2 px-5 font-semibold"
              onClick={onSetCredential}
              disabled={strategyUpdating}
            >
              <KeyIcon className="size-4 shrink-0" />
              Connect my account
            </Button>
          }
        >
          Your account stays private. Only your own private sessions can use it.
        </InfoBanner>
      ) : null}

      {showStatus ? (
        <OverviewStatus connector={connector} displayName={displayName} hasSummary={!!summary} />
      ) : null}

      {summary ? <OverviewSummary summary={summary} /> : null}
    </div>
  );
}

/**
 * Where the connector stands, read off its own record — no invented copy, and
 * no claim the record cannot support.
 *
 * Reachable only when neither connect CTA nor the computer redirect applies,
 * so under project authorization this is always the CONNECTED case — the CTA
 * above already covers "not connected yet". A user-strategy connector has one
 * credential per person, none of which this record knows about, so it is
 * never reported as "not connected" here — that account list is the Accounts
 * rung's job.
 */
function OverviewStatus({
  connector,
  displayName,
  hasSummary,
}: {
  connector: AdminConnector;
  displayName: string;
  hasSummary: boolean;
}) {
  const isChannel = connector.provider === 'channel';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';

  const headline = isChannel
    ? `${displayName} is a channel your agent talks through.`
    : !connector.authSecret
      ? 'No credential is needed.'
      : usesProjectAuthorization
        ? 'Sessions in this project use this account.'
        : 'Only your private sessions use your account.';

  const detail = isChannel
    ? 'Its connection, and what the agent may send through it, are managed under Accounts.'
    : null;

  return (
    <section className="space-y-2">
      <Label>Status</Label>
      <div className="bg-popover space-y-1.5 rounded-md border px-4 py-5">
        <p className="text-foreground text-sm font-medium">{headline}</p>
        {detail ? <p className="text-muted-foreground text-sm text-pretty">{detail}</p> : null}
        {/* The action count lives in "What it does" once there is one to show;
            repeating it here would just say the same number twice. */}
        {!hasSummary ? (
          <p className="text-muted-foreground text-sm">
            No tools have been synchronized for this connector yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * "What it does" — a read/write count plus up to four representative action
 * names, derived from `connector.actions` alone. Never rendered for zero
 * actions (`summarizeConnectorActions` returns `null`), which is the shape
 * the `verify-api` verification fixture exercises.
 */
function OverviewSummary({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof summarizeConnectorActions>>;
}) {
  const total = summary.readCount + summary.writeCount;
  const shown = summary.sampleNames.length;

  return (
    <section className="space-y-2">
      <Label>What it does</Label>
      <div className="bg-popover space-y-2.5 rounded-md border px-4 py-5">
        <p className="text-foreground text-sm font-medium">
          {describeConnectorActionCounts(summary)}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {summary.sampleNames.map((name, index) => (
            <Badge key={`${name}-${index}`} variant="outline" size="sm" className="font-mono">
              {name}
            </Badge>
          ))}
          {total > shown ? (
            <span className="text-muted-foreground text-xs">+{total - shown} more</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
