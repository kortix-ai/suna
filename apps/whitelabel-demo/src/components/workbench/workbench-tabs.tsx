'use client';

import { AgentPicker } from '@/components/chat/agent-picker';
import { Composer } from '@/components/chat/composer';
import { MessageView } from '@/components/chat/message-view';
import { ModelPicker } from '@/components/chat/model-picker';
import { PermissionPrompt } from '@/components/chat/permission-prompt';
import { QuestionPrompt } from '@/components/chat/question-prompt';
import { useChat } from '@/components/chat/use-chat';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import { useCanonicalOpenCodeSession } from '@kortix/sdk/react';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

/** The workbench tabs: Chat + the SDK-powered Files / Changes / Preview panels. */
export function WorkbenchTabs({
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
      <TabsContent
        value="chat"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
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
  const c = useChat({ projectId, sessionId, ocSessionId });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [c.messages, c.busy, c.hasPending]);

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
              key={(p as any).id}
              request={p}
              onResolved={() => c.removePermission((p as any).id)}
            />
          ))}
          {c.questions.map((q) => (
            <QuestionPrompt
              key={(q as any).id}
              request={q}
              onResolved={() => c.removeQuestion((q as any).id)}
              onCancel={c.cancel}
            />
          ))}

          {c.busy && !c.hasPending && (
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
          {c.phase !== 'ready' && c.phase !== 'booting' && (
            <p className="mb-2 text-center text-xs text-muted-foreground">
              {c.phase === 'unreachable' ? 'Reconnecting to the runtime…' : 'Connecting…'}
            </p>
          )}
          <Composer
            onSend={c.sendMessage}
            onStop={c.cancel}
            busy={c.busy}
            disabled={c.phase !== 'ready'}
            placeholder={
              c.phase === 'ready'
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
