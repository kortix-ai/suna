'use client';

import { FullPageLoading, Notice } from '@/components/access';
import { ThreadWorkbench } from '@/components/thread-workbench';
import { api } from '@convex/_generated/api';
import { ChatCircleSlashIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import { useParams } from 'next/navigation';

/** One thread. The URL carries Lumen ids only; Convex resolves the session behind it. */
export default function ThreadPage() {
  const params = useParams();
  const got = useQuery(api.threads.get, { threadId: String(params.threadId) });
  if (got === undefined) return <FullPageLoading />;
  if (got === null || got.thread.matterId !== params.matterId) {
    return (
      <Notice
        icon={ChatCircleSlashIcon}
        title="Conversation not found"
        body="It was deleted, or it belongs to another matter."
        href={`/app/matters/${String(params.matterId)}/assistant`}
        cta="Back to the assistant"
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadWorkbench
        key={got.thread.kortixSessionId}
        projectId={got.kortixProjectId}
        sessionId={got.thread.kortixSessionId}
        matterId={got.thread.matterId}
      />
    </div>
  );
}
