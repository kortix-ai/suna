'use client';

import { ProjectShell } from '@/components/project-shell';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { WorkbenchTabs } from '@/components/workbench/workbench-tabs';
import { kortix } from '@/lib/kortix';
import { SessionRuntime } from '@/lib/runtime';
import { qk } from '@/lib/query-keys';
import { switchToSessionSandboxAsync } from '@kortix/sdk/server-store';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function SessionWorkbenchPage() {
  return (
    <ProjectShell>
      <Workbench />
    </ProjectShell>
  );
}

function Workbench() {
  const params = useParams();
  const projectId = String(params.id);
  const sessionId = String(params.sessionId);

  // 1. Drive /start until the runtime is ready (server long-polls).
  const start = useQuery({
    queryKey: qk.sessionStart(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).start(15_000),
    refetchInterval: (q) => {
      const stage = q.state.data?.stage;
      return stage === 'ready' || stage === 'failed' || stage === 'stopped' ? false : 1500;
    },
  });
  const startData = start.data ?? null;
  const ready = startData?.stage === 'ready';

  // 2. Point the SDK's active runtime at this session's sandbox once ready.
  const [switched, setSwitched] = useState(false);
  const switchedFor = useRef<string | null>(null);
  useEffect(() => {
    const sandbox = startData?.sandbox;
    if (!ready || !sandbox) return;
    if (switchedFor.current === sandbox.sandbox_id) return;
    switchedFor.current = sandbox.sandbox_id;
    let cancelled = false;
    switchToSessionSandboxAsync(projectId, sessionId, sandbox).then((res) => {
      if (!cancelled && res) setSwitched(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, projectId, sessionId, startData?.sandbox]);

  return (
    <>
      <SessionHeader projectId={projectId} sessionId={sessionId} />
      {!ready || !switched ? (
        <BootScreen
          stage={startData?.stage}
          reason={startData?.reason}
          failed={startData?.stage === 'failed' || startData?.stage === 'stopped'}
          onRetry={() => start.refetch()}
        />
      ) : (
        <SessionRuntime>
          <WorkbenchTabs
            projectId={projectId}
            sessionId={sessionId}
            pinFromStart={startData?.opencode_session_id ?? null}
          />
        </SessionRuntime>
      )}
    </>
  );
}
