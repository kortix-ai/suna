'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { ProjectShell } from '@/components/project-shell';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { kortix } from '@/lib/kortix';
import { SessionRuntime, useRuntimePhase } from '@/lib/runtime';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { clearStartStash, readStartStash } from '@/lib/session-start';
import { cn } from '@/lib/utils';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreVertical, Pencil, RotateCw, Sparkles, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
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

function Header({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
    retry: false,
  });
  const title =
    session.data?.name || session.data?.custom_name || session.data?.branch_name || 'Session';
  const status = session.data?.status;

  // Runtime liveness probe (GET /kortix/health) for the header dot.
  const health = useQuery({
    queryKey: ['session-health', projectId, sessionId],
    queryFn: () => kortix.session(projectId, sessionId).health(),
    refetchInterval: 15_000,
    retry: false,
  });
  const ready = (health.data as any)?.ok && (health.data as any)?.health?.runtimeReady;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          ready ? 'bg-emerald-500' : health.data ? 'bg-amber-500' : 'bg-muted-foreground/40',
        )}
        title={ready ? 'Runtime healthy' : 'Runtime warming up'}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
      </div>
      {status && (
        <Badge variant="secondary" className="capitalize">
          {status}
        </Badge>
      )}
      <SessionActions projectId={projectId} sessionId={sessionId} currentName={title} />
    </header>
  );
}

/** Session lifecycle actions: rename (update), restart, delete. */
function SessionActions({
  projectId,
  sessionId,
  currentName,
}: {
  projectId: string;
  sessionId: string;
  currentName: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  const rename = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).update({ name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(projectId, sessionId) });
      invalidateSessions(qc, projectId);
      setRenaming(false);
      toast.success('Session renamed');
    },
    onError: () => toast.error('Could not rename'),
  });
  const restart = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionStart(projectId, sessionId) });
      toast.success('Restarting the session…');
    },
    onError: () => toast.error('Could not restart'),
  });
  const remove = useMutation({
    mutationFn: () => kortix.session(projectId, sessionId).delete(),
    onSuccess: () => {
      invalidateSessions(qc, projectId);
      toast.success('Session deleted');
      router.push(`/projects/${projectId}`);
    },
    onError: () => toast.error('Could not delete'),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Session actions">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setName(currentName);
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => restart.mutate()} disabled={restart.isPending}>
            <RotateCw className="size-4" /> Restart
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && rename.mutate()}
          />
          <DialogFooter>
            <Button disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The workbench tabs: Chat + the SDK-powered Files / Changes / Preview panels. */
function WorkbenchTabs({
  projectId,
  sessionId,
  pinFromStart,
}: {
  projectId: string;
  sessionId: string;
  pinFromStart: string | null;
}) {
  return (
    <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="border-b border-border px-5">
        <TabsList className="h-10 bg-transparent p-0">
          {(['chat', 'files', 'changes', 'preview'] as const).map((v) => (
            <TabsTrigger
              key={v}
              value={v}
              className="h-10 rounded-none border-b-2 border-transparent bg-transparent px-3 capitalize text-muted-foreground shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {v}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <Chat projectId={projectId} sessionId={sessionId} pinFromStart={pinFromStart} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden p-4">
        <FilesPanel projectId={projectId} />
      </TabsContent>
      <TabsContent value="changes" className="min-h-0 flex-1 overflow-hidden p-4">
        <ChangesPanel projectId={projectId} sessionId={sessionId} />
      </TabsContent>
      <TabsContent value="preview" className="min-h-0 flex-1 overflow-hidden p-4">
        <PreviewPanel projectId={projectId} sessionId={sessionId} />
      </TabsContent>
    </Tabs>
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
  return <Thread projectId={projectId} sessionId={sessionId} ocSessionId={rootSessionId} />;
}

function Thread({
  projectId,
  sessionId,
  ocSessionId,
}: {
  projectId: string;
  sessionId: string;
  ocSessionId: string;
}) {
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

  // SDK model layer feeds the picker + the model we send with. Agents come from
  // the SDK SERVER-SIDE (project config), not the sandbox runtime — so the
  // roster is identical to the new-session screen and survives a cold runtime.
  const providers = useOpenCodeProviders();
  const config = useOpenCodeConfig();
  const agents = useVisibleAgents({ projectId });
  const local = useOpenCodeLocal({
    agents,
    providers: providers.data,
    config: config.data,
    sessionId: ocSessionId,
  });

  // Persist the picked model onto the session handle (the facade's opinionated
  // setModel) alongside the React model store, so either send path agrees.
  useEffect(() => {
    if (local.model.currentKey) {
      kortix.session(projectId, sessionId).setModel(local.model.currentKey);
    }
  }, [local.model.currentKey, projectId, sessionId]);

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

  const handleSend = (
    text: string,
    override?: { model?: { providerID: string; modelID: string } | null; agent?: string | null },
  ) => {
    setPending(text);
    // Every message carries the selected model AND agent (the SDK send hook
    // forwards both to the runtime). Overrides win (used for the opening turn);
    // otherwise we read the live picker selections. Omit either for the default.
    const model = override?.model ?? local.model.currentKey;
    const agentName = override?.agent ?? local.agent.current?.name;
    const options = {
      ...(model ? { model } : {}),
      ...(agentName ? { agent: agentName } : {}),
    };
    send.mutate(
      {
        sessionId: ocSessionId,
        parts: [{ type: 'text', text }],
        ...(Object.keys(options).length ? { options } : {}),
      },
      {
        onError: () => {
          toast.error('Could not send your message');
          setPending(null);
        },
      },
    );
  };

  // Replay the "new session" hand-off: once the runtime is ready and the thread
  // is empty, send the stashed prompt with the chosen model + agent so they
  // apply to the opening turn. Runs exactly once per session.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || phase !== 'ready' || isLoading) return;
    const stash = readStartStash(sessionId);
    if (!stash) return;
    if (messages.length > 0) {
      clearStartStash(sessionId);
      startedRef.current = true;
      return;
    }
    startedRef.current = true;
    clearStartStash(sessionId);
    if (stash.model) local.model.set(stash.model, { recent: true });
    if (stash.agent) local.agent.set(stash.agent);
    handleSend(stash.prompt, { model: stash.model, agent: stash.agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isLoading, messages.length, sessionId]);

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
            toolbar={
              <div className="flex items-center gap-0.5">
                <ModelPicker model={local.model} />
                <AgentPicker agent={local.agent} />
              </div>
            }
          />
        </div>
      </div>
    </>
  );
}
