'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import type { UseSessionResult } from '@kortix/sdk/react';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

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
          {c.runtimePhase !== 'ready' && c.runtimePhase !== 'booting' && (
            <p className="mb-2 text-center text-xs text-muted-foreground">
              {c.runtimePhase === 'unreachable' ? 'Reconnecting to the runtime…' : 'Connecting…'}
            </p>
          )}
          <Composer
            onSend={c.send}
            onStop={c.cancel}
            busy={c.isBusy}
            disabled={c.runtimePhase !== 'ready'}
            placeholder={
              c.runtimePhase === 'ready'
                ? 'Message the agent…  (/ for commands)'
                : 'Waiting for the runtime…'
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
