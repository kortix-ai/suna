'use client';

import { ProjectShell } from '@/components/project-shell';
import { ReviewInbox } from '@/components/review/review-inbox';
import { useParams } from 'next/navigation';

export default function ProjectReviewPage() {
  const projectId = String(useParams().id);
  return (
    <ProjectShell>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="text-xl font-semibold tracking-tight">Review</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything the agents need a human decision on, in one inbox.
          </p>
          <div className="mt-6">
            <ReviewInbox projectId={projectId} />
          </div>
        </div>
      </div>
    </ProjectShell>
  );
}
