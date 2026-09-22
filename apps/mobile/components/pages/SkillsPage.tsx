/**
 * SkillsPage — the project's OpenCode skills (web parity: customize/skills).
 * The skills under `.kortix/opencode/skills/`; a tap shows the skill's
 * `SKILL.md`. Authoring flows through a session (New / Edit).
 *
 * A row is the skill's name, then its description on one line below it
 * (Jay, 2026-09-21). No icon.
 * Layout and behaviour: `ConfigEntriesPage`, shared with the Agents page.
 */
import * as React from 'react';

import { ConfigEntriesPage } from '@/components/pages/ConfigEntriesPage';
import { useProjectDetail } from '@/lib/projects/hooks';

interface SkillsPageProps {
  page: { id: string; label: string };
  projectId: string;
  /** Start an agent-led config session seeded with `prompt` (New / Edit). */
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function SkillsPage({
  page,
  projectId,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isRightDrawerOpen,
}: SkillsPageProps) {
  const { data, isLoading, isError, error, refetch } = useProjectDetail(projectId);
  return (
    <ConfigEntriesPage
      kind="skill"
      noun="skills"
      title={page.label}
      projectId={projectId}
      entries={data?.config?.skills ?? []}
      isLoading={isLoading}
      errorMessage={isError ? ((error as Error)?.message ?? 'Unable to load skills') : null}
      onRetry={() => void refetch()}
      onConfigure={onConfigure}
      onOpenDrawer={onOpenDrawer}
      onOpenRightDrawer={onOpenRightDrawer}
      isRightDrawerOpen={isRightDrawerOpen}
    />
  );
}
