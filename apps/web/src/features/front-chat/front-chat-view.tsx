'use client';

// The front chat (flag `infinichat`): one endless chat with Kortix. You see
// your messages and the messages Kortix sends you, nothing else. Each task
// runs in its own thread (a My Kortix child session) out of sight; Kortix
// talks to the threads and tells you only what matters.
import { openFrontChat } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { SessionThread } from '@kortix/ui/session';
import { TranscriptRowsContext } from '@kortix/ui/session/thread/transcript-rows';
import { useQuery } from '@tanstack/react-query';
import '@kortix/ui/session/tool/tools/register';

const ROWS = { agent: 'Kortix', agentSlug: 'mykortix', owner: null, unknownAuthor: 'You', messagesOnly: true };

export function FrontChatView({ projectId }: { projectId: string }) {
  const chat = useQuery({
    queryKey: ['front-chat', projectId],
    queryFn: () => openFrontChat(projectId),
    staleTime: Infinity,
  });
  if (chat.isLoading) return <Loading />;
  if (chat.error || !chat.data) return <ErrorState title="Kortix could not open your chat" description={String(chat.error ?? '')} />;
  return <FrontChat projectId={projectId} sessionId={chat.data.session_id} />;
}

function FrontChat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="kx-titlebar-row flex h-12 shrink-0 items-center border-b px-5">
        <h1 className="text-base font-semibold">Kortix</h1>
      </header>
      <TranscriptRowsContext.Provider value={ROWS}>
        <SessionThread session={session} hideHeader composerPlaceholder="Tell Kortix anything" className="min-h-0 flex-1" />
      </TranscriptRowsContext.Provider>
    </div>
  );
}
