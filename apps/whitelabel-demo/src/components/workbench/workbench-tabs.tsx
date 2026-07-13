'use client';

import { Composer } from '@/components/chat/composer';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message } from '@/components/ui/message';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import type { UseSessionResult } from '@kortix/sdk/react';
import { projectAcpChatItems } from '@kortix/sdk';
import { Loader2 } from 'lucide-react';
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
      <div className="px-5 pt-3.5">
        <TabsList>
          {(['chat', 'files', 'changes', 'preview'] as const).map((v) => (
            <TabsTrigger key={v} value={v} className="px-3.5 capitalize">
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
function Thread({ session }: { session: UseSessionResult }) {
  return <AcpThread acp={session.acp} />;
}

function AcpThread({ acp }: { acp: UseSessionResult['acp'] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = projectAcpChatItems(acp.envelopes);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [items.length, acp.busy]);
  return (
    <>
      <div ref={scrollRef} className="scroll-fade flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {!items.length && <p className="py-16 text-center text-sm text-muted-foreground">Send a message to get the agent working.</p>}
          {items.map((item, index) => item.kind === 'message' ? (
            <Message key={index} align={item.role === 'user' ? 'end' : 'start'}>
              <Bubble variant={item.role === 'user' ? 'secondary' : 'default'} align={item.role === 'user' ? 'end' : 'start'}><BubbleContent>{item.text}</BubbleContent></Bubble>
            </Message>
          ) : item.kind === 'permission' ? (
            <div key={index} className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-2 text-sm font-medium">Permission requested</p>
              <div className="flex flex-wrap gap-2">
                {(Array.isArray(item.params.options) ? item.params.options as Array<Record<string, unknown>> : []).map((option) => {
                  const id = String(option.optionId ?? option.id);
                  return <Button key={id} size="sm" onClick={() => void acp.respondPermission(item.id, id)}>{String(option.name ?? option.title ?? id)}</Button>;
                })}
                <Button size="sm" variant="secondary" onClick={() => void acp.respondPermission(item.id)}>Reject</Button>
              </div>
            </div>
          ) : (
            <div key={index} className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              {item.kind === 'tool'
                ? item.title
                : item.kind === 'plan'
                  ? 'Plan updated'
                  : item.kind === 'question'
                    ? 'Input requested'
                    : item.method}
            </div>
          ))}
          {acp.busy && <Marker><MarkerIcon><Loader2 className="animate-spin" /></MarkerIcon><MarkerContent>Agent is working…</MarkerContent></Marker>}
        </div>
      </div>
      <div className="shrink-0 px-5 pb-5"><div className="mx-auto max-w-3xl"><Composer onSend={(text) => void acp.send([{ type: 'text', text }])} onStop={() => void acp.cancel()} busy={acp.busy} disabled={!acp.ready} /></div></div>
    </>
  );
}
