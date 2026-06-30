'use client';

/**
 * The git / changes view for the white-label workbench. A single panel with two
 * tabs — "Commits" (the project's git history + session commit + base compare)
 * and "Change requests" (Kortix's native PR layer). Everything routes through the
 * `@kortix/sdk` facade: `kortix.project(id).git.*`, `.changeRequests.*`, and the
 * session-scoped `kortix.session(id, sid).commit()`. No raw HTTP.
 *
 * This file is a thin composer: the `Tabs` shell delegating to the extracted
 * `CommitsView` and `ChangeRequestsView` (under `./changes/`).
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GitCommitHorizontal, GitPullRequest } from 'lucide-react';
import { ChangeRequestsView } from './changes/change-requests-view';
import { CommitsView } from './changes/commits-view';

export function ChangesPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <Tabs defaultValue="commits" className="flex h-full min-h-0 flex-col">
        <TabsList className="mx-3 mt-3 shrink-0 self-start">
          <TabsTrigger value="commits">
            <GitCommitHorizontal className="size-3.5" />
            Commits
          </TabsTrigger>
          <TabsTrigger value="change-requests">
            <GitPullRequest className="size-3.5" />
            Change requests
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="commits"
          className="min-h-0 flex-1 overflow-hidden p-3 data-[state=inactive]:hidden"
        >
          <CommitsView projectId={projectId} sessionId={sessionId} />
        </TabsContent>
        <TabsContent
          value="change-requests"
          className="min-h-0 flex-1 overflow-hidden p-3 data-[state=inactive]:hidden"
        >
          <ChangeRequestsView projectId={projectId} sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
