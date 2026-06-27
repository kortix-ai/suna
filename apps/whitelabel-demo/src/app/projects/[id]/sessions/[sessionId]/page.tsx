'use client';

import { ProjectShell } from '@/components/project-shell';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { WorkbenchTabs } from '@/components/workbench/workbench-tabs';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { SessionRuntime } from '@/lib/runtime';
import { switchToSessionSandboxAsync } from '@kortix/sdk/server-store';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

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
  // Track WHICH sandbox we've switched to (not a bare boolean) so navigating to
  // another session — which reuses this component instance — re-gates instead of
  // rendering the new session against the previous sandbox.
  const [switchedSandboxId, setSwitchedSandboxId] = useState<string | null>(null);
  useEffect(() => {
    const sandbox = startData?.sandbox;
    if (!ready || !sandbox || switchedSandboxId === sandbox.sandbox_id) return;
    let cancelled = false;
    switchToSessionSandboxAsync(projectId, sessionId, sandbox).then((res) => {
      if (!cancelled && res) setSwitchedSandboxId(sandbox.sandbox_id);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, projectId, sessionId, startData?.sandbox, switchedSandboxId]);

  const switched =
    ready && !!startData?.sandbox && switchedSandboxId === startData.sandbox.sandbox_id;

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
