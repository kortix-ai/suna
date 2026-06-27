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
  useOpenCodePendingStore,
  useOpenCodeProviders,
  useSendOpenCodeMessage,
  useSessionSync,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { switchToSessionSandboxAsync } from '@kortix/sdk/server-store';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

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
  const { messages, isBusy, isLoading } = useSessionSync(ocSessionId);
  const send = useSendOpenCodeMessage();
  const abort = useAbortOpenCodeSession();
  const phase = useRuntimePhase();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Interactive prompts live in the pending store (the SSE stream writes them
  // there). Select the stable record maps, then derive this session's items —
  // reading raw arrays in the selector would re-render on every store tick.
  const questionMap = useOpenCodePendingStore((s) => s.questions);
  const permissionMap = useOpenCodePendingStore((s) => s.permissions);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const questions = useMemo(
    () => Object.values(questionMap).filter((q) => (q as any).sessionID === ocSessionId),
    [questionMap, ocSessionId],
  );
  const permissions = useMemo(
    () => Object.values(permissionMap).filter((p) => (p as any).sessionID === ocSessionId),
    [permissionMap, ocSessionId],
  );
  const hasPending = questions.length > 0 || permissions.length > 0;

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

  // Optimistic send: show the user's message instantly until the server echoes
  // it back over SSE. Without this, hitting send feels like nothing happened.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) return;
    const echoed = messages.some(
      (m) =>
        m.info.role === 'user' &&
        (m.parts as any[]).some((p) => p.type === 'text' && p.text?.trim() === pending.trim()),
    );
    if (echoed) setPending(null);
  }, [messages, pending]);

  const sending = !!pending;
  const busy = isBusy || sending;

  const handleSend = (text: string) => {
    setPending(text);
    send.mutate(
      {
        sessionId: ocSessionId,
        parts: [{ type: 'text', text }],
        ...(local.model.currentKey ? { options: { model: local.model.currentKey } } : {}),
      },
      {
        onError: () => {
          toast.error('Could not send your message');
          setPending(null);
        },
      },
    );
  };

  // The one true "cancel": abort the run AND drop any pending prompts so the UI
  // never wedges waiting on a server-side answer.
  const cancelRun = () => {
    abort.mutate(ocSessionId);
    questions.forEach((q) => removeQuestion((q as any).id));
    permissions.forEach((p) => removePermission((p as any).id));
    setPending(null);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, hasPending]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {isLoading && (
            <div className="flex items-center gap-2.5 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversation…
            </div>
          )}
          {!isLoading && messages.length === 0 && !hasPending && !pending && (
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

          {pending && (
            <div className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary/70 px-4 py-2.5 text-sm text-secondary-foreground">
                {pending}
              </div>
            </div>
          )}

          {permissions.map((p) => (
            <PermissionPrompt key={(p as any).id} request={p} onResolved={() => removePermission((p as any).id)} />
          ))}
          {questions.map((q) => (
            <QuestionPrompt
              key={(q as any).id}
              request={q}
              onResolved={() => removeQuestion((q as any).id)}
              onCancel={cancelRun}
            />
          ))}

          {busy && !hasPending && (
            <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
              <span className="ml-1 text-xs">{sending ? 'Sending…' : 'Agent is working…'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto max-w-3xl">
          {phase !== 'ready' && phase !== 'booting' && (
            <p className="mb-2 text-center text-xs text-muted-foreground">
              {phase === 'unreachable' ? 'Reconnecting to the runtime…' : 'Connecting…'}
            </p>
          )}
          <Composer
            onSend={handleSend}
            onStop={cancelRun}
            busy={busy}
            disabled={phase !== 'ready'}
            placeholder={phase === 'ready' ? 'Message the agent…' : 'Waiting for the runtime…'}
            toolbar={<ModelPicker model={local.model} />}
          />
        </div>
      </div>
    </>
  );
}
