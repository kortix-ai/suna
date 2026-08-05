'use client';

import { createConnector, type PipedreamApp } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  buildEasyConnectProfileDraft,
  connectorSyncErrorForSlug,
  proposeConnectorProfileSlug,
} from '@/features/workspace/customize/sections/connector-profile-form';
import { ConnectorProfileIcon } from '@/features/workspace/customize/sections/connector-profile-header';
import { ConnectorProfileModal } from '@/features/workspace/customize/sections/connector-profile-modal';

/**
 * Add one Easy Connect (Pipedream) app to the project: name the profile,
 * create the connector, hand the slug back so the page can open its detail.
 *
 * ── Known duplication, read before changing either side ────────────────────
 * `AppCatalogue` in `connectors-view.tsx` runs this identical mutation for the
 * Add-connector modal's Easy Connect tab. This is the same split, for the same
 * reason, as `DiscoverAddFlow` vs `discover-catalogue.tsx` — see that file's
 * header. What is shared is already shared: `ConnectorProfileModal`,
 * `buildEasyConnectProfileDraft`, `proposeConnectorProfileSlug` and
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
    mutationFn: async (profile: Parameters<typeof buildEasyConnectProfileDraft>[1]) => {
      if (!app) throw new Error('Select an app');
      const draft = buildEasyConnectProfileDraft(app, profile);
      const result = await createConnector(projectId, draft);
      return {
        name: draft.name ?? app.name,
        slug: draft.slug,
        syncError: connectorSyncErrorForSlug(result, draft.slug),
      };
    },
    onSuccess: (profile) => {
      if (profile.syncError) {
        warningToast(
          `Added ${profile.name} to the manifest, but synchronization failed: ${profile.syncError}. Use Sync to retry.`,
        );
        onAdded();
        onClose();
        return;
      }
      successToast(`Added ${profile.name} — click Connect to authorize`);
      onAdded(profile.slug);
      onClose();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add'),
  });

  // Read-only members can open a card but must not be offered the create form.
  if (!canWrite) return null;

  return (
    <ConnectorProfileModal
      open={app !== null}
      idPrefix="easy-connect-profile"
      title={`Add ${app?.name ?? 'app'}`}
      description="Create a connector profile for this app. The profile name and slug identify it in sessions and project configuration."
      initialName={app?.name ?? ''}
      initialSlug={app ? proposeConnectorProfileSlug(app.name, existingSlugs) : ''}
      existingSlugs={existingSlugs}
      pending={add.isPending}
      icon={<ConnectorProfileIcon src={app?.imgSrc} name={app?.name ?? ''} />}
      summary={app?.description ?? null}
      onOpenChange={(open) => !open && onClose()}
      onSubmit={(profile) => add.mutate(profile)}
    />
  );
}
