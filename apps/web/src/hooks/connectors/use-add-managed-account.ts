'use client';

import { usePipedreamConnectMember } from '@/hooks/connectors/use-pipedream-connect-member';
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
import { grantConnectionAccess } from '@/features/workspace/shared/access/access-dialog-share';
import {
  newAccountGrantees,
  type NewAccountDraft,
} from '@/features/workspace/customize/sections/view/connector-connections';

/**
 * Add a NEW named account to a managed (Composio/Pipedream) connector, for the
 * audience the Add account form chose, and resolve with its connection id.
 *
 * Only you creates the caller's own account. Everyone and specific people
 * create a shared one; for specific people the grants are written after the
 * row exists and before the provider window opens, so the account never holds
 * a credential while it is open to the whole project. Errors toast in the
 * underlying hooks and reject here.
 */
export function useAddManagedAccount(
  projectId: string,
  slug: string,
  accountId: string | null | undefined,
  onConnected: () => void,
) {
  const addMine = usePipedreamConnectMember(projectId, slug, onConnected);
  const addProject = usePipedreamConnectProject(projectId, slug, onConnected);
  return {
    isPending: addMine.isPending || addProject.isPending,
    add: async (draft: NewAccountDraft): Promise<{ connectionId: string | null }> => {
      const label = draft.label.trim();
      if (draft.audience === 'private') return addMine.mutateAsync({ label });
      return addProject.mutateAsync({
        label,
        beforeAuthorize:
          draft.audience === 'members'
            ? (connectionId) =>
                grantConnectionAccess(
                  accountId ?? '',
                  projectId,
                  connectionId,
                  newAccountGrantees(draft.picked),
                )
            : undefined,
      });
    },
  };
}
