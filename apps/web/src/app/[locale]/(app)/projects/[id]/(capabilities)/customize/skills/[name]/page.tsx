'use client';

import { useParams } from 'next/navigation';

import { SkillDetailPage } from '@/features/workspace/capabilities/skills/skill-detail-page';

/**
 * `/projects/[id]/customize/skills/[name]` — one skill, as a page. The skills
 * list opens a card in a modal; this is the URL surface the API scan keys on
 * (the skill's folder slug, also matched by scan name). See
 * `features/workspace/capabilities/skills/skill-detail-page.tsx`.
 *
 * `name` is URL-encoded by every link that points here — decoded here once,
 * like the agents detail page, so the page works with the real name.
 */
export default function ProjectSkillDetailPage() {
  const { id: projectId, name } = useParams<{ id: string; name: string }>();
  let segment = name;
  try {
    segment = decodeURIComponent(name);
  } catch {
    // A malformed escape in a hand-typed URL: use the raw segment and let the
    // page's not-found state say the skill does not exist.
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SkillDetailPage key={segment} projectId={projectId} segment={segment} />
    </div>
  );
}
