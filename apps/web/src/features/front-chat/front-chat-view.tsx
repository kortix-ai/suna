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
import { useMemo, useState } from 'react';
import '@kortix/ui/session/tool/tools/register';

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

function threadStateText(thread: ProjectSession): string {
  if (thread.board_state === 'needs_input') return 'Needs you';
  if (thread.board_state === 'working' || thread.working?.state === 'working') return 'Working…';
  if (thread.board_state === 'failed') return 'Failed';
  const replies = thread.reply_count ?? 0;
  return replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'Done';
}

/** The threads one answer started, Slack-style, under its words. A click opens the thread on the right. */
function ThreadLines({
  ids,
  byId,
  openId,
  onOpen,
}: {
  ids: readonly string[];
  byId: ReadonlyMap<string, ProjectSession>;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {ids.map((id) => {
        const thread = byId.get(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            aria-pressed={openId === id}
            className="group/thread hover:bg-hover aria-pressed:bg-hover focus-visible:ring-ring -mx-1 flex w-full max-w-xl items-start gap-2 rounded-md px-1 py-1 text-left text-xs outline-none focus-visible:ring-2"
          >
            <span className="mt-0.5">{thread ? <ThreadStatus thread={thread} /> : <Loading className="size-3.5 shrink-0" />}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-foreground truncate font-semibold">{thread ? threadLabel(thread) : 'Starting a thread…'}</span>
                {thread ? <span className="text-muted-foreground shrink-0">{threadStateText(thread)}</span> : null}
                <span className="text-muted-foreground ml-auto hidden shrink-0 group-hover/thread:inline">View thread ›</span>
              </span>
              {thread?.result_excerpt && thread.board_state !== 'working' ? (
                <span className="text-muted-foreground line-clamp-1">{thread.result_excerpt}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FrontChat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  const [open, setOpen] = useState<string | null>(null);
  const threads = useQuery({
    queryKey: ['front-chat-threads', projectId, sessionId],
    queryFn: async () => (await listProjectSessions(projectId, { parent: sessionId })).filter((row) => row.agent_name === 'mykortix'),
    refetchInterval: 3_000,
  });
  const byId = useMemo(() => new Map((threads.data ?? []).map((row) => [row.session_id, row])), [threads.data]);
  const running = (threads.data ?? []).filter((t) => t.board_state === 'working' || t.board_state === 'needs_input').length;
  const rows = useMemo(
    () => ({
      agent: 'Kortix',
      agentSlug: 'mykortix',
      owner: null,
      unknownAuthor: 'You',
      messagesOnly: true,
      renderThreads: (ids: readonly string[]) => <ThreadLines ids={ids} byId={byId} openId={open} onOpen={setOpen} />,
    }),
    [byId, open],
  );
  return (
    <div className="bg-background flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="kx-titlebar-row flex h-12 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="text-base font-semibold">Kortix</h1>
          <span className="text-muted-foreground text-xs">{running > 0 ? `${running} running` : 'One chat. Tell it anything.'}</span>
        </header>
        <TranscriptRowsContext.Provider value={rows}>
          <SessionThread session={session} hideHeader composerPlaceholder="Tell Kortix anything" className="min-h-0 flex-1" />
        </TranscriptRowsContext.Provider>
      </div>
      {open ? (
        <ThreadPanel
          projectId={projectId}
          sessionId={open}
          title={byId.get(open) ? threadLabel(byId.get(open)!) : 'Thread'}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/** One thread on the right: its whole work, and a reply box that talks to it directly. */
function ThreadPanel({ projectId, sessionId, title, onClose }: { projectId: string; sessionId: string; title: string; onClose: () => void }) {
  const session = useSession(projectId, sessionId);
  return (
    <aside aria-label="Thread" className="flex min-h-0 w-[440px] shrink-0 flex-col border-l">
      <div className="kx-titlebar-row flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm"><span className="font-semibold">Thread</span> <span className="text-muted-foreground">{title}</span></h2>
        <Link href={`/projects/${projectId}/sessions/${sessionId}`} className="text-muted-foreground hover:text-foreground shrink-0 text-xs">
          Open full session
        </Link>
        <Button variant="ghost" size="icon-md" aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <TranscriptRowsContext.Provider value={THREAD_ROWS}>
        <SessionThread key={sessionId} session={session} hideHeader density="compact" composerPlaceholder="Reply…" className="min-h-0 flex-1" />
      </TranscriptRowsContext.Provider>
    </aside>
  );
}
