'use client';

/**
 * Skills, signed out — ux-references/perplexity/08-skills-list.png.
 *
 * The real screen (features/workspace/skills/skills-section.tsx) reads
 * `config.skills` from a project-scoped endpoint, so with no session there is
 * nothing to fetch. Rather than show a fourth empty state, this renders the
 * same ProjectSectionPage and the same SkillCard grid over the skills every
 * Kortix project is created with — real names, real descriptions, read out of
 * packages/starter (see demo-skills-data.ts). Nothing here is invented.
 *
 * The card is the product's own SkillCard, not a lookalike: a visitor is
 * looking at the actual screen, and it cannot drift from it.
 */

import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';
import { SkillCard } from '@/features/workspace/skills/skill-card';
import {
  SKILLS_DOCS_HREF,
  SKILL_KINDS,
  SKILL_KIND_ORDER,
} from '@/features/workspace/skills/skill-entities';
import type { ReactNode } from 'react';

import { DemoAction, DemoPills, demoSearch } from './demo-controls';
import { DEMO_SKILLS } from './demo-skills-data';

const PILLS = SKILL_KIND_ORDER.map((kind) => ({
  id: kind,
  label: SKILL_KINDS[kind].label,
}));

export function SkillsDemo({ navTabs }: { navTabs?: ReactNode }) {
  const { gate } = useSignInGate();
  const onGate = () => gate('/');

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Skills"
      description="Reusable capabilities and slash commands your agents can call."
      docsHref={SKILLS_DOCS_HREF}
      width="wide"
      search={demoSearch(SKILL_KINDS.skill.searchPlaceholder, onGate)}
      action={<DemoAction label={SKILL_KINDS.skill.newLabel} onGate={onGate} />}
      filters={<DemoPills options={PILLS} active="skill" onGate={onGate} />}
      state="ready"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {DEMO_SKILLS.map((entity) => (
          <SkillCard
            key={entity.path}
            kind="skill"
            entity={entity}
            onOpen={onGate}
            onEdit={onGate}
          />
        ))}
      </div>
    </ProjectSectionPage>
  );
}

export default SkillsDemo;
