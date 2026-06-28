'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { UseSessionResult } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** The workbench tabs: Chat + the SDK-powered Files / Changes / Preview panels. */
export function WorkbenchTabs({
  session,
  projectId,
  sessionId,
}: {
  session: UseSessionResult;
  projectId: string;
  sessionId: string;
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
      <TabsContent
        value="chat"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <Thread session={session} />
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

/**
 * The chat thread. Reads everything off the single `useSession` result — messages,
 * optimistic send, interactive prompts, the model/agent picks, and the runtime
 * phase. No useChat, no useCanonicalOpenCodeSession, no sandbox wiring.
 */
function Thread({ session: c }: { session: UseSessionResult }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [c.messages, c.isBusy, c.hasPending]);

  // ── Runtime recovery ──────────────────────────────────────────────────────
  // Sandboxes idle-stop (and die) in the real world. Rather than silently
  // disabling the composer (so Enter "does nothing"), surface the state and
  // recover: restart() wakes the box and re-arms useSession's /start poll.
  const qc = useQueryClient();
  const restart = useMutation({
    mutationFn: () => kortix.session(c.projectId, c.sessionId).restart(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessionStart(c.projectId, c.sessionId) });
      toast.success('Reconnecting the runtime…');
    },
    onError: () => toast.error('Could not reconnect the runtime'),
  });

  const runtimeReady = c.runtimePhase === 'ready';
  // "Down" = was connected, now confirmed unreachable (a drop, not the initial boot).
  const runtimeDown = c.switched && c.runtimePhase === 'unreachable';

  // Auto-reconnect ONCE per down-episode. The ref guard prevents a restart loop
  // on a box that can't recover; the flag resets when the runtime comes back, so
  // a later drop is retried again.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (!runtimeDown) {
      autoTriedRef.current = false;
      return;
    }
    if (autoTriedRef.current || restart.isPending) return;
    autoTriedRef.current = true;
    restart.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeDown]);

  // Stall watchdog: if the agent is "working" but nothing has streamed for a
  // while, the run likely lost its runtime — surface it instead of an endless
  // spinner. Any new message/part or a busy-state change resets the timer.
  const [stalled, setStalled] = useState(false);
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    lastActivityRef.current = Date.now();
    setStalled(false);
  }, [c.messages, c.isBusy, c.hasPending]);
  useEffect(() => {
    if (!c.isBusy) {
      setStalled(false);
      return;
    }
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current > 60_000) setStalled(true);
    }, 5_000);
    return () => clearInterval(id);
  }, [c.isBusy]);

  // The OpenCode root id is resolved inside useSession; show a connect state
  // until it lands (the chat can't address a session without it).
  if (!c.opencodeSessionId) {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to the agent…
        </div>
      </div>
    );
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {c.isLoading && (
            <div className="flex items-center gap-2.5 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversation…
            </div>
          )}
          {!c.isLoading && c.messages.length === 0 && !c.hasPending && !c.pending && (
            <div className="grid place-items-center py-16 text-center">
              <Sparkles className="size-6 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                Send a message to get the agent working.
              </p>
            </div>
          )}

          {c.messages.map((m) => (
            <MessageView key={m.info.id} message={m} />
          ))}

          {c.pending && (
            <div className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary/70 px-4 py-2.5 text-sm text-secondary-foreground">
                {c.pending}
              </div>
            </div>
          )}

          {c.permissions.map((p) => (
            <PermissionPrompt
              key={(p as { id: string }).id}
              request={p}
              onResolved={() => c.removePermission((p as { id: string }).id)}
            />
          ))}
          {c.questions.map((q) => (
            <QuestionPrompt
              key={(q as { id: string }).id}
              request={q}
              onResolved={() => c.removeQuestion((q as { id: string }).id)}
              onCancel={c.cancel}
            />
          ))}

          {c.isBusy && !c.hasPending && (
            <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
              <span className="ml-1 text-xs">{c.pending ? 'Sending…' : 'Agent is working…'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto max-w-3xl">
          {runtimeDown ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-amber-200">
                <AlertTriangle className="size-3.5 shrink-0" />
                {restart.isPending
                  ? 'Reconnecting the runtime…'
                  : 'The runtime stopped. Reconnect to keep chatting.'}
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 gap-1.5"
                onClick={() => restart.mutate()}
                disabled={restart.isPending}
              >
                <RotateCw className={cn('size-3.5', restart.isPending && 'animate-spin')} />
                Restart
              </Button>
            </div>
          ) : !runtimeReady ? (
            <p className="mb-2 text-center text-xs text-muted-foreground">
              Connecting to the runtime…
            </p>
          ) : stalled && c.isBusy ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="size-3.5 shrink-0" />
                The agent has gone quiet — it may have lost its runtime.
              </div>
              <Button size="sm" variant="secondary" className="h-7 gap-1.5" onClick={c.cancel}>
                Stop
              </Button>
            </div>
          ) : null}
          <Composer
            onSend={c.send}
            onStop={c.cancel}
            busy={c.isBusy}
            disabled={!runtimeReady}
            placeholder={
              runtimeReady ? 'Message the agent…  (/ for commands)' : 'Waiting for the runtime…'
            }
            commands={c.commands}
            onCommand={c.runCommand}
            toolbar={
              <div className="flex items-center gap-0.5">
                <ModelPicker models={c.models} value={c.picks.model} onChange={c.picks.setModel} />
                <AgentPicker
                  agents={c.agents}
                  value={c.picks.agent}
                  onChange={c.picks.setAgent}
                  defaultName={c.defaultAgent}
                />
              </div>
            }
          />
        </div>
      </div>
    </>
  );
}
