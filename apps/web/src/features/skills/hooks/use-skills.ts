'use client';

import { useQuery } from '@tanstack/react-query';
import { listSkills } from '../api/skills-api';
import type { Skill } from '../types';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const skillsKeys = {
  all: ['opencode', 'skills'] as const,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetch all available skills from the OpenCode server.
 *
 * This replaces the old `useOpenCodeSkills` hook from use-opencode-sessions.ts
 * with a feature-scoped version that uses the same query key so the cache
 * stays unified.
 */
export function useSkills() {
  return useQuery<Skill[]>({
    queryKey: skillsKeys.all,
    queryFn: listSkills,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
