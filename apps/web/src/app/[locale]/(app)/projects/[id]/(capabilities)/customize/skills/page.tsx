'use client';

import { useParams } from 'next/navigation';

import { SkillsPage } from '@kortix/ui/customize';

/**
 * /projects/[id]/skills — the standalone Skills catalog. See
 * `packages/ui/src/customize/skills/skills-page.tsx` for the page body.
 */
export default function ProjectSkillsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SkillsPage projectId={projectId} />
    </div>
  );
}
