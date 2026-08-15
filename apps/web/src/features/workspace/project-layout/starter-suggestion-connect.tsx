'use client';

/**
 * The connector-suggestion row on project home, the shared row shell it
 * shares with the skill-suggestion row, and the connect modal.
 *
 * Split out of `starter-suggestions.tsx` because the row needs a real nested
 * `Button` (the "Connect" trailing control) and the modal needs its own data
 * (existing connector slugs, the connect mutation) — neither belongs in the
 * list component that just picks which row shape to render. `SuggestionActionRow`
 * lives here too, rather than in `starter-suggestions.tsx`, so the skill row
 * (built there) reuses the exact same a11y scaffolding instead of a second
 * copy.
 *
 * Same connect flow `ToolsStep` uses in onboarding
 * (`components/projects/onboarding/steps/tools-step.tsx`): propose a slug,
 * default to a project-owned connection, keep rename/ownership behind the
 * modal's own advanced disclosure, and hand the submitted draft to
 * `useToolConnect` for the create → OAuth popup → finalize round trip.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  connectorConnectionQueryKeys,
  proposeConnectorConnectionSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { ConnectorConnectionIcon } from '@/features/workspace/customize/sections/connector-connection-header';
import { ConnectorConnectionModal } from '@/features/workspace/customize/sections/connector-connection-modal';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';
import { cn } from '@/lib/utils';
import { listConnectors } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

export interface PendingConnectorApp {
  slug: string;
  name: string;
  imgSrc: string | null;
}

/**
 * Shared row shell for a starter-suggestion row that hosts a real trailing
 * button rather than just navigating or prefilling on its own click — a
 * leading icon slot, the row label, and a trailing button slot.
 *
 * The row is a non-button container (`role="button"`, not a `<button>`), and
 * the trailing button is the one real `<button>` inside it — the same shape
 * `SessionRow` uses for a clickable row that hosts a real trailing control
 * (`project-sessions/session-row.tsx`), because a `<button>` cannot legally
 * nest another `<button>`. The button's own click stops propagation purely
 * to avoid firing `onAction` twice (row bubble + button); both paths call
 * the identical handler, so this is not a behavior fork.
 *
 * Used by `ConnectorSuggestionRow` (icon = app logo, button = "Connect") and
 * the skill row on project home (icon = Sparkle, button = "Create skill").
 */
export function SuggestionActionRow({
  label,
  icon,
  buttonLabel,
  onAction,
}: {
  label: string;
  icon: ReactNode;
  buttonLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onAction}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onAction();
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
        'hover:bg-muted/60 transition-colors duration-150 active:scale-[0.99]',
        'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
      )}
    >
      {icon}
      <span className="text-foreground/90 line-clamp-1 min-w-0 flex-1 text-sm leading-snug">
        {label}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          onAction();
        }}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

/**
 * A connector-suggestion row: app icon, label, trailing "Connect" button —
 * both open the same modal.
 */
export function ConnectorSuggestionRow({
  label,
  app,
  onConnect,
}: {
  label: string;
  app: PendingConnectorApp;
  onConnect: () => void;
}) {
  return (
    <SuggestionActionRow
      label={label}
      icon={<ConnectorConnectionIcon src={app.imgSrc} name={app.name} />}
      buttonLabel="Connect"
      onAction={onConnect}
    />
  );
}

/**
 * The "Add connector" modal for a clicked suggestion row. `existingSlugs` is
 * fetched only while a row is actually being connected (`enabled:
 * pendingApp !== null`) — browsing project home never fires a connectors
 * round trip.
 */
export function StarterSuggestionConnectModal({
  projectId,
  pendingApp,
  onOpenChange,
}: {
  projectId: string;
  pendingApp: PendingConnectorApp | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    enabled: pendingApp !== null,
  });
  const existingSlugs = connectorsQuery.data?.connectors.map((connector) => connector.slug) ?? [];

  // Fires whenever the mutation resolves — success, a sync/authorization
  // warning, or a cancelled OAuth popup all resolve normally (see
  // `useToolConnect`'s own `onSuccess`, which already toasts the right
  // message for each case). Only a hard failure (network, name/slug
  // conflict) throws and leaves the modal open to retry — same as
  // `ToolsStep`.
  const connect = useToolConnect(projectId, () => {
    onOpenChange(false);
    for (const key of connectorConnectionQueryKeys(projectId)) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  });

  return (
    <ConnectorConnectionModal
      open={pendingApp !== null}
      idPrefix="starter-suggestion-connector"
      title={`Add ${pendingApp?.name ?? 'app'}`}
      description="Create a connector connection before authorization. You can add more than one connection for the same app."
      initialName={pendingApp?.name ?? ''}
      initialSlug={
        pendingApp ? proposeConnectorConnectionSlug(pendingApp.name, existingSlugs) : ''
      }
      existingSlugs={existingSlugs}
      pending={connect.isPending}
      icon={
        pendingApp ? <ConnectorConnectionIcon src={pendingApp.imgSrc} name={pendingApp.name} /> : null
      }
      onOpenChange={(open) => !open && onOpenChange(false)}
      onSubmit={(connection) => {
        if (!pendingApp) return;
        connect.mutate({
          appSlug: pendingApp.slug,
          appName: pendingApp.name,
          connectorName: connection.name,
          connectorSlug: connection.slug,
          authorizationStrategy: connection.authorizationStrategy,
        });
      }}
    />
  );
}
