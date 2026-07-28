'use client';

/**
 * Skills, as rendered by the Customize overlay's `case 'skills'`.
 *
 * The screen itself now lives in features/workspace/skills — one flat page with
 * a Skills | Commands pill row instead of the master-detail split. Uncontrolled
 * here: the overlay has no URL to hold the tab in, so the section keeps its own.
 */

import { SkillsSection } from '@/features/workspace/skills/skills-section';

export function SkillsView({ projectId }: { projectId: string }) {
  return <SkillsSection projectId={projectId} />;
}

export default SkillsView;
