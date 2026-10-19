'use client';

import { ScopeBar } from '@/components/chat/scope-bar';
import { ChangesPanel } from '@/components/workbench/changes-panel';
import { FilesPanel } from '@/components/workbench/files-panel';
import { PreviewPanel } from '@/components/workbench/preview-panel';
import { SessionScope } from '@/components/workbench/session-scope';
import { useRuntimeRecovery } from '@/components/workbench/use-runtime-recovery';
import type { UseSessionResult } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';

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
          {(['chat', 'files', 'changes', 'preview', 'scope'] as const).map((v) => (
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
      {/* What this session can still change. Shown as a first-class tab rather
          than a settings footnote: 'can I switch the agent / secrets now?' is a
          question people ask mid-session, and the answers genuinely differ. */}
      <TabsContent value="scope" className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-xl">
          <h2 className="text-sm font-medium">What this session can change</h2>
          <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
            Overrides are set when a session starts. These are the ones you can still move.
          </p>
          <SessionScope projectId={projectId} sessionId={sessionId} />
        </div>
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
 * The chat thread: @kortix/ui's SessionThread, the same thread apps/web
 * renders, over the single `useSession` result (transcript, tool rows,
 * prompts, composer with the model and agent pickers). Lumen hides the
 * thread header (its own SessionHeader is above the tabs), adds the
 * session's scope under the thread, and the one-shot auto-restart when a
 * connected runtime drops (`useRuntimeRecovery`). No second chat hook and no
 * transport code.
 */
function Thread({ session }: { session: UseSessionResult }) {
  useRuntimeRecovery(session);
  return (
    <>
      <SessionThread session={session} hideHeader className="flex-1" />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-3">
        <ScopeBar
          projectId={session.projectId}
          sessionId={session.sessionId}
          pickedModel={session.picks.model}
        />
      </div>
    </>
  );
}
