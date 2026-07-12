'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { Composer, type ComposerAttachment } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message } from '@/components/ui/message';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AuditPanel } from '@/components/workbench/audit-panel';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import { TerminalPanel } from '@/components/workbench/terminal-panel';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { UseSessionResult } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** The workbench tabs: Chat + the SDK-powered Files / Changes / Preview /
 *  Terminal / Audit panels. */
export function WorkbenchTabs({
  session,
  projectId,
  sessionId,
}: {
  session: UseSessionResult;
  projectId: string;
  sessionId: string;
}) {
  // Per-session pending-approval count for the Audit tab badge.
  const needsInput = useQuery({
    queryKey: ['approvals-needs-input', projectId],
    queryFn: () => kortix.project(projectId).approvals.sessionsNeedingInput({ showErrors: false }),
    refetchInterval: 15_000,
    retry: false,
  });
  const pendingCount = needsInput.data?.sessions?.[sessionId] ?? 0;

  return (
    <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="px-5 pt-3.5">
        <TabsList>
          {(['chat', 'files', 'changes', 'preview', 'terminal'] as const).map((v) => (
            <TabsTrigger key={v} value={v} className="px-3.5 capitalize">
              {v}
            </TabsTrigger>
          ))}
          <TabsTrigger value="audit" className="gap-1.5 px-3.5">
            Audit
            {pendingCount > 0 && (
              <span className="grid size-4 place-items-center rounded-full bg-amber-500/20 text-[0.65rem] font-medium tabular-nums text-amber-500">
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
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
      {/* forceMount keeps the shell's WebSocket alive across tab switches. */}
      <TabsContent
        value="terminal"
        forceMount
        className="min-h-0 flex-1 overflow-hidden p-4 data-[state=inactive]:hidden"
      >
        <TerminalPanel projectId={projectId} />
      </TabsContent>
      <TabsContent value="audit" className="min-h-0 flex-1 overflow-hidden p-4">
        <AuditPanel projectId={projectId} sessionId={sessionId} />
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

  // Attachments: upload into the session workspace (`session.files.upload`),
  // then weave the workspace paths into the outgoing prompt — the agent reads
  // them from disk like any other file.
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachFiles = (files: File[]) => {
    for (const file of files) {
      setAttachments((prev) => [
        ...prev.filter((a) => a.name !== file.name),
        { name: file.name, path: null },
      ]);
      kortix
        .session(c.projectId, c.sessionId)
        // The daemon only accepts absolute paths under its allowed roots
        // (/workspace, /tmp, …) — a bare relative dir 403s.
        .files.upload(file, '/workspace/uploads')
        .then((results) => {
          const path = results[0]?.path ?? `/workspace/uploads/${file.name}`;
          setAttachments((prev) => prev.map((a) => (a.name === file.name ? { ...a, path } : a)));
        })
        .catch(() => {
          setAttachments((prev) =>
            prev.map((a) => (a.name === file.name ? { ...a, error: true } : a)),
          );
          toast.error(`Could not upload ${file.name}`);
        });
    }
  };
  const sendWithAttachments = (text: string) => {
    const paths = attachments.filter((a) => a.path).map((a) => `- ${a.path}`);
    const finalText = paths.length
      ? `${text}\n\nAttached files (already in the workspace):\n${paths.join('\n')}`
      : text;
    c.send(finalText);
    setAttachments([]);
  };

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
      <div ref={scrollRef} className="scroll-fade flex-1 overflow-y-auto scrollbar-thin">
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
            <Message align="end">
              <Bubble variant="secondary" align="end" className="opacity-70">
                <BubbleContent>{c.pending}</BubbleContent>
              </Bubble>
            </Message>
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
            <Marker className="py-1">
              <MarkerIcon>
                <Loader2 className="animate-spin" />
              </MarkerIcon>
              <MarkerContent className="shimmer text-sm">
                {c.pending ? 'Sending…' : 'Agent is working…'}
              </MarkerContent>
            </Marker>
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
            onSend={sendWithAttachments}
            onStop={c.cancel}
            busy={c.isBusy}
            disabled={!runtimeReady}
            placeholder={
              runtimeReady ? 'Message the agent…  (/ for commands)' : 'Waiting for the runtime…'
            }
            commands={c.commands}
            onCommand={c.runCommand}
            attachments={attachments}
            onAttachFiles={attachFiles}
            onRemoveAttachment={(name) =>
              setAttachments((prev) => prev.filter((a) => a.name !== name))
            }
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
