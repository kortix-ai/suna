'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createSkill } from '../api/skills-api';
import { skillsKeys } from './use-skills';
import type { CreateSkillInput } from '../types';

/**
 * Mutation hook to create a new global skill.
 *
 * Creates a SKILL.md file in ~/.config/opencode/skills/<name>/
 * and invalidates the skills query cache on success.
 */
export function useCreateSkill() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, CreateSkillInput>({
    mutationFn: createSkill,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillsKeys.all });
    },
  });
}
