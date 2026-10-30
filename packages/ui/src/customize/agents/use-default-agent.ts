'use client';

import { errorToast, successToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { updateProjectDefaultAgent } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useDefaultAgent(projectId: string) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => updateProjectDefaultAgent(projectId, name),
    onSuccess: async (result) => {
      successToast(t('text0bb557895b32', { value0: capitalizeWords(result.default_agent) }));
      await client.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || t.raw('text7f724c2ad694')),
  });
}
