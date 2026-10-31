'use client';

/**
 * A Kortix built-in skill, opened from its card in Project admin → Skills: the
 * same modal as a project skill (`EntityDetailModal`: the file tree, the
 * frontmatter card, the rendered SKILL.md), read-only. A built-in skill ships
 * with Kortix and is not a file in the project's repo, so its files come from
 * `getBuiltinSkill(name, { full: true })`, read once and shared by the tree
 * and the pane.
 */

import { getBuiltinSkill } from '@kortix/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { EntityDetailModal, type EntityFileSource } from '../shared/entity/entity-modal';

export function BuiltinSkillModal({
  projectId,
  name,
  description,
  onOpenChange,
}: {
  projectId: string;
  name: string | null;
  description: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const source = useMemo<EntityFileSource | undefined>(() => {
    if (!name) return undefined;
    const skill = () =>
      queryClient.ensureQueryData({
        queryKey: ['builtin-skill', name, 'full'],
        queryFn: () => getBuiltinSkill(name, { full: true }),
        staleTime: 5 * 60_000,
      });
    return {
      key: `builtin-skill:${name}`,
      list: async () => {
        const s = await skill();
        return [{ path: `${name}/SKILL.md` }, ...s.references.map((ref) => ({ path: `${name}/${ref.path}` }))];
      },
      read: async (path) => {
        const s = await skill();
        const relative = path.slice(name.length + 1);
        if (relative === 'SKILL.md') return { content: s.body };
        return { content: s.references.find((ref) => ref.path === relative)?.content ?? '' };
      },
    };
  }, [name, queryClient]);

  return (
    <EntityDetailModal
      projectId={projectId}
      entity={name ? { name, path: `${name}/SKILL.md`, description } : null}
      kind="skill"
      open={!!name}
      source={source}
      onOpenChange={onOpenChange}
    />
  );
}
