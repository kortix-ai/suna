'use client';

import {
  type ConnectorDraftInput,
  createConnector,
  deleteConnector,
  setConnectorCredential,
} from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

import { createConnectorWithOptionalOAuth2, type OAuth2CredentialForm } from './connector-oauth2';

/**
 * The custom connector form's save. The connector exists in every outcome
 * that resolves, so it always hands off to the connector's page: a pending
 * MCP sign-in opens "Add account" ("Only you" preselected), a failed sync
 * shows its reason and Retry there. A rejected create or credential leaves
 * the form open with what the user typed.
 */
export function useCreateCustomConnector(
  projectId: string,
  onAdded: (slug: string, options: { addAccount: boolean }) => void,
) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tConnectorPages = useTranslations('connectorPages');
  return useMutation({
    mutationFn: (input: { draft: ConnectorDraftInput; oauth2: OAuth2CredentialForm | null }) =>
      createConnectorWithOptionalOAuth2(projectId, input.draft, input.oauth2, {
        createConnector,
        deleteConnector,
        setConnectorCredential,
      }),
    onSuccess: (result, { draft }) => {
      if (result.syncError) {
        warningToast(
          tConnectorPages('installedSyncFailed', { name: draft.slug, error: result.syncError }),
        );
      } else {
        successToast(
          result.credentialStored
            ? tI18nHardcoded('i18nComplete.text5120ee26cbf5', { value0: draft.slug })
            : tI18nHardcoded('i18nComplete.text29f396e2d238', { value0: draft.slug }),
        );
      }
      onAdded(draft.slug, { addAccount: result.signInPending });
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.textbdc7d54433e6')),
  });
}
