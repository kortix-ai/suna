'use client';

import { useParams } from 'next/navigation';

import { MembersPage } from '@/features/workspace/capabilities/members/members-page';

/**
 * /projects/[id]/members — the standalone Members page. See
 * `features/workspace/capabilities/members/members-page.tsx` for the page
 * body.
 */
export default function ProjectMembersPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MembersPage projectId={projectId} />
    </div>
  );
}
