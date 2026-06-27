'use client';

import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { Button, Spinner } from '@/components/ui';
import { kortix } from '@/lib/kortix';
import { SessionRuntime, useRuntimePhase } from '@/lib/runtime';
import {
  useAbortOpenCodeSession,
  useCanonicalOpenCodeSession,
  useOpenCodeConfig,
  useOpenCodeLocal,
  useOpenCodeProviders,
  useSendOpenCodeMessage,
  useSessionSync,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { switchToSessionSandboxAsync } from '@kortix/sdk/server-store';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function SessionWorkbench() {
  const params = useParams();
  const projectId = String(params.id);
  const sessionId = String(params.sessionId);

  // 1. Drive the session-open (/start) until the runtime is ready. The server
  //    long-polls, so `ready` arrives the instant the sandbox + OpenCode are up.
  const start = useQuery({
    queryKey: ['session-start', projectId, sessionId],
    queryFn: () => kortix.session(projectId, sessionId).start(15_000),
    refetchInterval: (q) => {
      const stage = q.state.data?.stage;
      return stage === 'ready' || stage === 'failed' || stage === 'stopped'
        ? false
        : 1500;
    },
  });
  const startData = start.data ?? null;
  const ready = startData?.stage === 'ready';

  // 2. Point the SDK's active server at THIS session's sandbox once ready. After
  //    this, every react hook (sync, SSE, send) talks to this session's runtime.
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
    <div className="flex h-dvh flex-col">
      <Header projectId={projectId} sessionId={sessionId} />
      {!ready || !switched ? (
        <BootScreen
          stage={startData?.stage}
          reason={startData?.reason}
          failed={startData?.stage === 'failed' || startData?.stage === 'stopped'}
          onRetry={() => start.refetch()}
        />
      ) : (
        <SessionRuntime>
          <Chat
            projectId={projectId}
            sessionId={sessionId}
            pinFromStart={startData?.opencode_session_id ?? null}
          />
        </SessionRuntime>
      )}
    </div>
  );
}

function Header({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: ['project-session', projectId, sessionId],
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
    retry: false,
  });
  const title =
    session.data?.name ||
    session.data?.custom_name ||
    session.data?.branch_name ||
    'Session';
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <Link href={`/projects/${projectId}`}>
        <Button variant="ghost" size="icon" aria-label="Back to project">
          <ArrowLeft className="size-4" />
        </Button>
      </Link>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-[var(--color-fg)]">{title}</div>
        <div className="truncate text-xs text-[var(--color-muted)]">
          {session.data?.status ?? 'session'}
        </div>
      </div>
    </header>
  );
}

function BootScreen({
  stage,
  reason,
  failed,
  onRetry,
}: {
  stage?: string;
  reason?: string;
  failed?: boolean;
  onRetry: () => void;
}) {
  const label =
    stage === 'provisioning'
      ? 'Provisioning sandbox…'
      : stage === 'starting'
        ? 'Starting the runtime…'
        : 'Connecting…';
  return (
    <div className="grid flex-1 place-items-center px-6">
      <div className="text-center">
        {failed ? (
          <>
            <p className="text-sm text-red-400">{reason || 'The session could not start.'}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-muted)]">
            <Spinner /> {label}
          </div>
        )}
      </div>
    </div>
  );
}

function Chat({
  projectId,
  sessionId,
  pinFromStart,
}: {
  projectId: string;
  sessionId: string;
  pinFromStart: string | null;
}) {
  const { rootSessionId } = useCanonicalOpenCodeSession({
    projectId,
    sessionId,
    pinFromStart,
  });

  if (!rootSessionId) {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex items-center gap-2.5 text-sm text-[var(--color-muted)]">
          <Spinner /> Connecting to the agent…
        </div>
      </div>
    );
  }
  return <Thread ocSessionId={rootSessionId} />;
}

function Thread({ ocSessionId }: { ocSessionId: string }) {
  const { messages, isBusy, isLoading } = useSessionSync(ocSessionId);
  const send = useSendOpenCodeMessage();
  const abort = useAbortOpenCodeSession();
  const phase = useRuntimePhase();
  const scrollRef = useRef<HTMLDivElement>(null);

  // The SDK's own model layer: providers/agents/config feed useOpenCodeLocal,
  // which resolves the selectable list + the current selection. We pass the
  // chosen key straight to send(); omitting it lets the agent use its default.
  const providers = useOpenCodeProviders();
  const config = useOpenCodeConfig();
  const agents = useVisibleAgents();
  const local = useOpenCodeLocal({
    agents,
    providers: providers.data,
    config: config.data,
    sessionId: ocSessionId,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [messages, isBusy]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {isLoading && (
            <div className="flex items-center gap-2.5 py-10 text-sm text-[var(--color-muted)]">
              <Spinner /> Loading conversation…
            </div>
          )}
          {!isLoading && messages.length === 0 && (
            <div className="grid place-items-center py-16 text-center">
              <Sparkles className="size-6 text-[var(--color-muted)]" />
              <p className="mt-3 text-sm text-[var(--color-muted)]">
                Send a message to get the agent working.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.info.id} message={m} />
          ))}
          {isBusy && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-muted)] [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-muted)] [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-muted)]" />
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto max-w-3xl space-y-2 px-5 py-4">
          <ModelPicker model={local.model} />
          <Composer
            onSend={(text) =>
              send.mutate({
                sessionId: ocSessionId,
                parts: [{ type: 'text', text }],
                ...(local.model.currentKey
                  ? { options: { model: local.model.currentKey } }
                  : {}),
              })
            }
            onStop={() => abort.mutate(ocSessionId)}
            busy={isBusy}
            disabled={phase !== 'ready'}
            placeholder={
              phase === 'ready' ? 'Message the agent…' : 'Waiting for the runtime…'
            }
          />
        </div>
      </div>
    </>
  );
}
