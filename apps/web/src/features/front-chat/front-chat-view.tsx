'use client';

// The front chat (flag `infinichat`): one endless chat with Kortix. You only
// talk; a My Kortix worker session does the work. Each answer is one row, its
// work folded behind one line (`TranscriptRowsContext`, as a channel thread).
import { listProjectSessions, openFrontChat } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { SessionThread } from '@kortix/ui/session';
import { TranscriptRowsContext } from '@kortix/ui/session/thread/transcript-rows';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import '@kortix/ui/session/tool/tools/register';

const ROWS = { agent: 'Kortix', agentSlug: 'mykortix', owner: null, unknownAuthor: 'You' };

export function FrontChatView({ projectId }: { projectId: string }) {
  const chat = useQuery({
    queryKey: ['front-chat', projectId],
    queryFn: () => openFrontChat(projectId),
    staleTime: Infinity,
  });
  if (chat.isLoading) return <Loading />;
  if (chat.error || !chat.data) return <ErrorState title="Kortix could not open your chat" description={String(chat.error ?? '')} />;
  return <FrontChatThread projectId={projectId} sessionId={chat.data.session_id} />;
}

function FrontChatThread({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  // The worker: the front's one child session. Openable, so the work stays visible.
  const worker = useQuery({
    queryKey: ['front-chat-worker', projectId, sessionId],
    queryFn: async () => (await listProjectSessions(projectId, { parent: sessionId })).find((row) => row.agent_name === 'mykortix') ?? null,
    refetchInterval: 10_000,
  });
  const workerId = worker.data?.session_id ?? null;
  const working = session.isBusy || worker.data?.working?.state === 'working';
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="kx-titlebar-row flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="text-base font-semibold">Kortix</h1>
        <span className="text-muted-foreground text-xs">{working ? 'Working on it' : 'One chat. Tell it anything.'}</span>
        <div className="flex-1" />
        {workerId ? (
          <Link href={`/projects/${projectId}/sessions/${workerId}`} className="text-muted-foreground hover:text-foreground text-xs">
            See the work
          </Link>
        ) : null}
      </header>
      <TranscriptRowsContext.Provider value={ROWS}>
        <SessionThread session={session} hideHeader composerPlaceholder="Tell Kortix anything" className="min-h-0 flex-1" />
      </TranscriptRowsContext.Provider>
    </div>
  );
}
