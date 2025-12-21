'use client';

import React from 'react';
import { ThreadComponent } from '@/components/thread/ThreadComponent';

export default function ThreadPage({
  params,
}: {
  params: Promise<{
    projectId: string;
    threadId: string;
  }>;
}) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'page.tsx:14',message:'Before React.use(params)',data:{hasParams:!!params},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion
  const unwrappedParams = React.use(params);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'page.tsx:16',message:'After React.use(params)',data:{unwrappedParams},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion
  const { projectId, threadId } = unwrappedParams;

  return <ThreadComponent projectId={projectId} threadId={threadId} />;
}
