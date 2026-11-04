'use client';

// The front chat (flag `infinichat`): one endless chat with Kortix. You only
// talk; each task runs in its own thread (a My Kortix child session), many at
// once. The threads sit above the chat with their status; one click opens a
// thread on the right, where you see its work and talk to it directly.
import { listProjectSessions, openFrontChat, type ProjectSession } from '@kortix/sdk';
import { useSession } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { SessionThread } from '@kortix/ui/session';
import { TranscriptRowsContext } from '@kortix/ui/session/thread/transcript-rows';
import { CheckIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import '@kortix/ui/session/tool/tools/register';

const CHAT_ROWS = { agent: 'Kortix', agentSlug: 'mykortix', owner: null, unknownAuthor: 'You', messagesOnly: true };
const THREAD_ROWS = { agent: 'Kortix', agentSlug: 'mykortix', owner: null, unknownAuthor: 'Kortix' };

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

/** A thread's name: its title, else the name Kortix gave it. */
function threadLabel(thread: ProjectSession): string {
  return thread.custom_name || thread.name || thread.agent_handle || 'Thread';
}

function ThreadStatus({ thread }: { thread: ProjectSession }) {
  if (thread.board_state === 'needs_input') return <WarningCircleIcon weight="fill" className="text-foreground size-3.5 shrink-0" />;
  if (thread.board_state === 'working' || thread.working?.state === 'working') return <Loading className="size-3.5 shrink-0" />;
  if (thread.board_state === 'failed') return <XIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <CheckIcon className="text-muted-foreground size-3.5 shrink-0" />;
}

function FrontChat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  const [open, setOpen] = useState<string | null>(null);
  const threads = useQuery({
    queryKey: ['front-chat-threads', projectId, sessionId],
    queryFn: async () =>
      (await listProjectSessions(projectId, { parent: sessionId }))
        .filter((row) => row.agent_name === 'mykortix')
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    refetchInterval: 4_000,
  });
  const list = threads.data ?? [];
  const running = list.filter((t) => t.board_state === 'working' || t.board_state === 'needs_input').length;
  return (
    <div className="bg-background flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="kx-titlebar-row flex h-12 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="text-base font-semibold">Kortix</h1>
          <span className="text-muted-foreground text-xs">
            {running > 0 ? `${running} running` : 'One chat. Tell it anything.'}
          </span>
        </header>
        {list.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-5 py-2" aria-label="Threads">
            <span className="text-muted-foreground mr-1 text-xs font-medium">Threads</span>
            {list.map((thread) => (
              <button
                key={thread.session_id}
                type="button"
                onClick={() => setOpen(thread.session_id)}
                aria-pressed={open === thread.session_id}
                title={thread.result_excerpt ?? undefined}
                className="hover:bg-hover aria-pressed:bg-hover focus-visible:ring-ring flex max-w-60 items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
              >
                <ThreadStatus thread={thread} />
                <span className="truncate">{threadLabel(thread)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <TranscriptRowsContext.Provider value={CHAT_ROWS}>
          <SessionThread session={session} hideHeader composerPlaceholder="Tell Kortix anything" className="min-h-0 flex-1" />
        </TranscriptRowsContext.Provider>
      </div>
      {open ? <ThreadPanel projectId={projectId} sessionId={open} title={threadLabel(list.find((t) => t.session_id === open) ?? ({} as ProjectSession))} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** One thread on the right: its whole work, and a reply box that talks to it directly. */
function ThreadPanel({ projectId, sessionId, title, onClose }: { projectId: string; sessionId: string; title: string; onClose: () => void }) {
  const session = useSession(projectId, sessionId);
  return (
    <aside aria-label="Thread" className="flex min-h-0 w-[440px] shrink-0 flex-col border-l">
      <div className="kx-titlebar-row flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <Link href={`/projects/${projectId}/sessions/${sessionId}`} className="text-muted-foreground hover:text-foreground shrink-0 text-xs">
          Open full session
        </Link>
        <Button variant="ghost" size="icon-md" aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <TranscriptRowsContext.Provider value={THREAD_ROWS}>
        <SessionThread key={sessionId} session={session} hideHeader density="compact" composerPlaceholder="Reply in this thread" className="min-h-0 flex-1" />
      </TranscriptRowsContext.Provider>
    </aside>
  );
}
