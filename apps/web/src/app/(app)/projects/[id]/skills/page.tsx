'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { ProjectSectionTabs } from '@/features/workspace/project-section/project-section-tabs';
import { parseSkillKind, skillKindQuery } from '@/features/workspace/skills/skill-entities';
import { SkillsSection } from '@/features/workspace/skills/skills-section';

/**
 * Route for the Skills section — skills AND commands, one screen.
 *
 * The active tab lives in `?tab=`, so `?tab=commands` is a real deep link (it
 * is where `resolveLegacyCustomizeHref` sends the legacy `commands` section)
 * and the back button walks between the two.
 */
function SkillsRoute({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const kind = parseSkillKind(searchParams?.get('tab'));

  return (
    <SkillsSection
      projectId={projectId}
      kind={kind}
      onKindChange={(next) =>
        router.replace(`/projects/${projectId}/skills${skillKindQuery(next)}`, { scroll: false })
      }
      navTabs={<ProjectSectionTabs projectId={projectId} active="skills" />}
    />
  );
}

export default function SkillsSectionPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;

  // useSearchParams needs a Suspense boundary to keep the route statically
  // renderable; without it the whole segment opts into client rendering.
  return (
    <Suspense fallback={null}>
      <SkillsRoute projectId={projectId} />
    </Suspense>
  );
}
