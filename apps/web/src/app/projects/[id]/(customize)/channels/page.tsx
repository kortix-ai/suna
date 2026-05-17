'use client';

import { MessageSquare } from 'lucide-react';

export default function ProjectChannelsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Channels</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-4 py-10">
          <div className="rounded-lg border border-border/70 bg-card p-6">
            <p className="text-sm font-medium text-foreground">Channels are being rebuilt.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The legacy channel implementation has been removed from the API. This entry stays here as the landing point for the replacement.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
