'use client';

import dynamic from 'next/dynamic';
import { SharePageWrapper } from './_components/SharePageWrapper';
import React from 'react';
import {
  ThreadParams,
} from '@/components/thread/types';

// Dynamic import to avoid SSR issues with browser-only dependencies
const ThreadComponent = dynamic(
  () => import('@/components/thread/ThreadComponent').then(mod => ({ default: mod.ThreadComponent })),
  { ssr: false }
);

export default function ShareThreadPage({
  params,
}: {
  params: Promise<ThreadParams>;
}) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;

  // For shared pages, projectId will be fetched from the thread data
  // Pass empty string - useThreadData will handle it via thread->project relationship
  const projectId = '';

  return (
    <SharePageWrapper>
      <ThreadComponent
        projectId={projectId}
        threadId={threadId}
        isShared={true}
      />
    </SharePageWrapper>
  );
}
