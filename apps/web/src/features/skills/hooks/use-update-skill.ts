'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateSkill } from '../api/skills-api';
import { skillsKeys } from './use-skills';
import type { UpdateSkillInput } from '../types';

/**
 * Mutation hook to update an existing skill.
 *
 * Overwrites the SKILL.md file at the skill's location path.
 */
export function useUpdateSkill() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { name: string; input: UpdateSkillInput }>({
    mutationFn: ({ name, input }) => updateSkill(name, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillsKeys.all });
    },
  });
}
