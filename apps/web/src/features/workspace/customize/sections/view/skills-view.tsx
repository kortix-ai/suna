'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { Sparkles } from 'lucide-react';

type Skill = ConfigEntity;

export function SkillsView({ projectId }: { projectId: string }) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE).allowed === true;
  return (
    <ConfigEntityView<Skill>
      projectId={projectId}
      kind="skill"
      noun="skill"
      layout="split"
      canWrite={canWrite}
      title="Skills"
      searchPlaceholder="Search skills"
      emptyIcon={Sparkles}
      emptyTitle="No skills yet"
      emptyDescription="Create a skill to give agents reusable capabilities."
      emptyDocsHref="https://agentclientprotocol.com/"
      emptyBodyLabel="Skill body is empty. Add content below the frontmatter."
      select={(config) => config.skills}
      renderTriggerLabel={(skill) => skill.name}
      renderDetailTitle={(skill) => skill.name}
    />
  );
}
