'use client';

import { use, Suspense } from 'react';
import { SessionChat } from '@/components/session/session-chat';
import { SessionLayout } from '@/components/session/session-layout';

export default function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);

  return (
    <Suspense fallback={null}>
      <SessionLayout sessionId={sessionId}>
        <SessionChat sessionId={sessionId} />
      </SessionLayout>
    </Suspense>
  );
}
