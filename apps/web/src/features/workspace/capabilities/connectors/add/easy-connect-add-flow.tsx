'use client';

import { createConnector, type PipedreamApp } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  buildEasyConnectConnectorDraft,
  connectorSyncErrorForSlug,
  proposeConnectorConnectionSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { ConnectorConnectionIcon } from '@/features/workspace/customize/sections/connector-connection-header';
import { ConnectorConnectionModal } from '@/features/workspace/customize/sections/connector-connection-modal';

/**
 * Add one Easy Connect (Pipedream) app to the project: name the connection,
 * create the connector, hand the slug back so the page can open its detail.
 *
 * ── Known duplication, read before changing either side ────────────────────
 * `AppCatalogue` in `connectors-view.tsx` runs this identical mutation for the
 * Add-connector modal's Easy Connect tab. This is the same split, for the same
 * reason, as `DiscoverAddFlow` vs `discover-catalogue.tsx` — see that file's
 * header. What is shared is already shared: `ConnectorConnectionModal`,
 * `buildEasyConnectConnectorDraft`, `proposeConnectorConnectionSlug` and
 * `connectorSyncErrorForSlug` are imported by both; only the mutation wrapper
 * is restated.
 *
 * The `onAdded` contract MUST match `DiscoverAddFlow`'s and `AppCatalogue`'s:
 * `(slug?: string)`, with the slug **omitted on a sync failure**. The page
 * opens the detail modal only when it receives a slug, and on a partial
 * failure (manifest written, sync failed) `listConnectors` may not return that
 * connector yet — passing it would strand `?c=<slug>` in the URL and pop an
 * empty modal open on a later refetch.
 */
export function EasyConnectAddFlow({
  projectId,
  app,
  existingSlugs,
  canWrite,
  onClose,
  onAdded,
}: {
  projectId: string;
  /** The app the user picked, or `null` when the flow is closed. */
  app: PipedreamApp | null;
  existingSlugs: readonly string[];
  canWrite: boolean;
  onClose: () => void;
  onAdded: (slug?: string) => void;
}) {
  const add = useMutation({
    mutationFn: async (connection: Parameters<typeof buildEasyConnectConnectorDraft>[1]) => {
      if (!app) throw new Error('Select an app');
      const draft = buildEasyConnectConnectorDraft(app, connection);
      const result = await createConnector(projectId, draft);
      return {
        name: draft.name ?? app.name,
        slug: draft.slug,
        syncError: connectorSyncErrorForSlug(result, draft.slug),
      };
    },
    onSuccess: (connection) => {
      if (connection.syncError) {
        warningToast(
          `Added ${connection.name} to the manifest, but synchronization failed: ${connection.syncError}. Use Sync to retry.`,
        );
        onAdded();
        onClose();
        return;
      }
      successToast(`Added ${connection.name} — click Connect to authorize`);
      onAdded(connection.slug);
      onClose();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add'),
  });

  // Read-only members can open a card but must not be offered the create form.
  if (!canWrite) return null;

  return (
    <ConnectorConnectionModal
      open={app !== null}
      idPrefix="easy-connect-connection"
      title={`Add ${app?.name ?? 'app'}`}
      description="Create a connection for this app. The connection name and slug identify it in sessions and project configuration."
      initialName={app?.name ?? ''}
      initialSlug={app ? proposeConnectorConnectionSlug(app.name, existingSlugs) : ''}
      existingSlugs={existingSlugs}
      pending={add.isPending}
      icon={<ConnectorConnectionIcon src={app?.imgSrc} name={app?.name ?? ''} />}
      summary={app?.description ?? null}
      onOpenChange={(open) => !open && onClose()}
      onSubmit={(connection) => add.mutate(connection)}
    />
  );
}
