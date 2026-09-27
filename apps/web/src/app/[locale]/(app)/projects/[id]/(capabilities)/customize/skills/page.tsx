'use client';

import { useParams } from 'next/navigation';

import { SkillsPage } from '@/features/workspace/capabilities/skills/skills-page';

/**
 * /projects/[id]/skills — the standalone Skills catalog. See
 * `features/workspace/capabilities/skills/skills-page.tsx` for the page body.
 */
export default function ProjectSkillsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SkillsPage projectId={projectId} />
    </div>
  );
}
