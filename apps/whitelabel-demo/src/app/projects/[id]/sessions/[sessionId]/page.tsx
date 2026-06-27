'use client';

import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { ProjectShell } from '@/components/project-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { kortix } from '@/lib/kortix';
import { SessionRuntime, useRuntimePhase } from '@/lib/runtime';
import { qk } from '@/lib/query-keys';
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
import { Loader2, Sparkles } from 'lucide-react';
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
    </>
  );
}

function Header({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
    retry: false,
  });
  const title =
    session.data?.name || session.data?.custom_name || session.data?.branch_name || 'Session';
  const status = session.data?.status;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
      </div>
      {status && (
        <Badge variant="secondary" className="capitalize">
          {status}
        </Badge>
      )}
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
      {failed ? (
        <div className="text-center">
          <p className="text-sm text-destructive">{reason || 'The session could not start.'}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {label}
        </div>
      )}
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
  const { rootSessionId } = useCanonicalOpenCodeSession({ projectId, sessionId, pinFromStart });
  if (!rootSessionId) {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to the agent…
        </div>
      </div>
    );
  }
  return <Thread ocSessionId={rootSessionId} />;
}

function Thread({ ocSessionId }: { ocSessionId: string }) {
  const { messages, isBusy, isLoading, questions, permissions } = useSessionSync(ocSessionId);
  const send = useSendOpenCodeMessage();
  const abort = useAbortOpenCodeSession();
  const phase = useRuntimePhase();
  const scrollRef = useRef<HTMLDivElement>(null);

  // SDK model layer feeds the picker + the model we send with.
  const providers = useOpenCodeProviders();
  const config = useOpenCodeConfig();
  const agents = useVisibleAgents();
  const local = useOpenCodeLocal({
    agents,
    providers: providers.data,
    config: config.data,
    sessionId: ocSessionId,
  });

  const hasPending = questions.length > 0 || permissions.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, isBusy, hasPending]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {isLoading && (
            <div className="flex items-center gap-2.5 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversation…
            </div>
          )}
          {!isLoading && messages.length === 0 && !hasPending && (
            <div className="grid place-items-center py-16 text-center">
              <Sparkles className="size-6 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                Send a message to get the agent working.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <MessageView key={m.info.id} message={m} />
          ))}

          {permissions.map((p) => (
            <PermissionPrompt key={p.id} request={p} />
          ))}
          {questions.map((q) => (
            <QuestionPrompt key={q.id} request={q} />
          ))}

          {isBusy && !hasPending && (
            <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto max-w-3xl">
          <Composer
            onSend={(text) =>
              send.mutate({
                sessionId: ocSessionId,
                parts: [{ type: 'text', text }],
                ...(local.model.currentKey ? { options: { model: local.model.currentKey } } : {}),
              })
            }
            onStop={() => abort.mutate(ocSessionId)}
            busy={isBusy}
            disabled={phase !== 'ready'}
            placeholder={phase === 'ready' ? 'Message the agent…' : 'Waiting for the runtime…'}
            toolbar={<ModelPicker model={local.model} />}
          />
        </div>
      </div>
    </>
  );
}
