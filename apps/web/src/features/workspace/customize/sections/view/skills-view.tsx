'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { Sparkles } from 'lucide-react';

type Skill = ConfigEntity;

export function SkillsView({ projectId }: { projectId: string }) {
  return (
    <ConfigEntityView<Skill>
      projectId={projectId}
      kind="skill"
      noun="skill"
      title="Skills"
      description="Pick a skill from the list to preview it, or create a new one."
      searchPlaceholder="Search skills"
      emptyIcon={Sparkles}
      emptyTitle="No skills yet"
      emptyDescription="Create a skill to give agents reusable capabilities."
      emptyDocsHref="https://opencode.ai/docs/skills/"
      emptyBodyLabel="Skill body is empty. Add content below the frontmatter."
      select={(config) => config.skills}
      renderTriggerLabel={(skill) => skill.name}
      renderDetailTitle={(skill) => skill.name}
    />
  );
}
