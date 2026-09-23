/**
 * Create a managed project — the one create path for `NewProjectSheet` and
 * the full-screen `/new` (COR-161). Validates the name
 * (`lib/projects/new-project-form.ts`), provisions with the starter skill kit,
 * and reports the result with haptics and a toast. Resolves to the project,
 * or null when validation or the request failed (already reported).
 */

import { useCallback } from 'react';

import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { useProvisionProject } from '@/lib/projects/hooks';
import { validateProjectName } from '@/lib/projects/new-project-form';
import type { KortixProject } from '@/lib/projects/projects-client';
import { starterTemplateForManagedProject } from './project-starter-template';

export function useCreateManagedProject() {
  const provision = useProvisionProject();
  const toast = useToast();
  const { mutateAsync } = provision;

  const create = useCallback(
    async (accountId: string | null, rawName: string): Promise<KortixProject | null> => {
      if (!accountId) {
        toast.error('Select an account first');
        return null;
      }
      const name = validateProjectName(rawName);
      if (!name.ok) {
        toast.error(name.error);
        return null;
      }
      try {
        haptics.medium();
        const project = await mutateAsync({
          account_id: accountId,
          name: name.name,
          starter_template: starterTemplateForManagedProject(),
        });
        haptics.success();
        toast.success('Project created');
        return project;
      } catch (err: any) {
        haptics.warning();
        toast.error(err?.message || 'Failed to create project');
        return null;
      }
    },
    [mutateAsync, toast]
  );

  return { create, isPending: provision.isPending };
}
