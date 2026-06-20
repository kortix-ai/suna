'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteSkill } from '../api/skills-api';
import { skillsKeys } from './use-skills';

/**
 * Mutation hook to delete a skill.
 *
 * Removes the skill's directory (and its SKILL.md file) from the filesystem.
 */
export function useDeleteSkill() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { location: string }>({
    mutationFn: ({ location }) => deleteSkill(location),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillsKeys.all });
    },
  });
}
