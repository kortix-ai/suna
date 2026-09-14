'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { SparkleIcon as Sparkles } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

type Skill = ConfigEntity;

const PROJECT_GROUP = 'Project';
const KORTIX_GROUP = 'Kortix';

/**
 * The `kortix-*` family is platform runtime, not the project's own work: it is
 * force-injected into every session at boot, so it reads the same in every
 * project and isn't meaningfully editable here. New projects only scaffold
 * `kortix-cli`, but repos created before that still carry the whole family —
 * folding it into its own collapsed group keeps those lists readable without
 * hiding anything.
 */
function groupForSkill(skill: Skill): string {
  return skill.name.startsWith('kortix-') ? KORTIX_GROUP : PROJECT_GROUP;
}

export function SkillsView({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE).allowed === true;
  return (
    <ConfigEntityView<Skill>
      projectId={projectId}
      kind="skill"
      noun="skill"
      layout="grid"
      canWrite={canWrite}
      title={tI18nComplete.raw('text66d0f523a379')}
      searchPlaceholder={tI18nComplete.raw('text76c02b7eddca')}
      emptyIcon={Sparkles}
      emptyTitle={tI18nComplete.raw('text32ae9b80f832')}
      emptyDescription={tI18nComplete.raw('text031b8fd1f46a')}
      emptyDocsHref="https://opencode.ai/docs/skills/"
      emptyBodyLabel={tI18nComplete.raw('textd2970d5a365f')}
      select={(config) => config.skills}
      groupBy={groupForSkill}
      groupOrder={[PROJECT_GROUP, KORTIX_GROUP]}
      collapsedGroups={[KORTIX_GROUP]}
      renderTriggerLabel={(skill) => skill.name}
      renderDetailTitle={(skill) => skill.name}
    />
  );
}
