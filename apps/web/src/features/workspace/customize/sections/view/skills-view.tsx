'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { SparkleIcon as Sparkles } from '@phosphor-icons/react';

type Skill = ConfigEntity;

const WORKSPACE_GROUP = 'Workspace';
const KORTIX_GROUP = 'Kortix';

/**
 * The `kortix-*` family is platform runtime, not the workspace's own work: it is
 * force-injected into every session at boot, so it reads the same in every
 * project and isn't meaningfully editable here. New workspaces only scaffold
 * `kortix-cli`, but repos created before that still carry the whole family —
 * folding it into its own collapsed group keeps those lists readable without
 * hiding anything.
 */
function groupForSkill(skill: Skill): string {
  return skill.name.startsWith('kortix-') ? KORTIX_GROUP : WORKSPACE_GROUP;
}

export function SkillsView({ workspaceId }: { workspaceId: string }) {
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SKILL_WRITE).allowed === true;
  return (
    <ConfigEntityView<Skill>
      workspaceId={workspaceId}
      kind="skill"
      noun="skill"
      layout="grid"
      canWrite={canWrite}
      title="Skills"
      searchPlaceholder="Search skills"
      emptyIcon={Sparkles}
      emptyTitle="No skills yet"
      emptyDescription="Create a skill to give agents reusable capabilities."
      emptyDocsHref="https://opencode.ai/docs/skills/"
      emptyBodyLabel="Skill body is empty. Add content below the frontmatter."
      select={(config) => config.skills}
      groupBy={groupForSkill}
      groupOrder={[WORKSPACE_GROUP, KORTIX_GROUP]}
      collapsedGroups={[KORTIX_GROUP]}
      renderTriggerLabel={(skill) => skill.name}
      renderDetailTitle={(skill) => skill.name}
    />
  );
}
