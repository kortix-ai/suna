'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { ThreadSkeleton } from '@/components/thread/content/ThreadSkeleton';

export default function ThreadPage({
  params,
}: {
  params: Promise<{
    threadId: string;
  }>;
}) {
  const unwrappedParams = React.use(params);
  const { threadId } = unwrappedParams;
  const router = useRouter();
  const threadQuery = useThreadQuery(threadId);

  useEffect(() => {
    if (threadQuery.data?.project_id) {
      router.replace(`/projects/${threadQuery.data.project_id}/thread/${threadId}`);
    } else if (threadQuery.isError) {
      // If thread doesn't exist or user doesn't have access, redirect to dashboard
      router.replace('/dashboard');
    }
  }, [threadQuery.data, threadQuery.isError, threadId, router]);

  // Show loading skeleton while fetching thread
  return <ThreadSkeleton isSidePanelOpen={false} />;
}

