'use client';

import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { DriveConflictsBar } from '@/features/drives/drive-conflicts-bar';

const DRIVE = 'synthetic-drive-conflicts';

/** Visual fixture: the real conflict control with synthetic cached query data. */
export default function DriveConflictsFixture() {
  const [folder, setFolder] = useState('/');
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    cache.setQueryData(qk.drives.conflicts(DRIVE), [
      {
        conflictId: 'synthetic-report',
        path: '/Shared/report (conflict copy).txt',
        originalPath: '/Shared/report.txt',
        detectedAt: new Date().toISOString(),
      },
      {
        conflictId: 'synthetic-notes',
        path: '/Shared/Notes/notes (conflict copy).txt',
        originalPath: '/Shared/Notes/notes.txt',
        detectedAt: new Date().toISOString(),
      },
    ]);
    return cache;
  });
  return (
    <QueryClientProvider client={client}>
      <main className="bg-background text-foreground flex h-dvh flex-col p-4">
        <h1 className="text-sm font-medium">Drive conflict fixture</h1>
        <p className="text-muted-foreground text-xs">Synthetic files · open folder: {folder}</p>
        <div data-testid="drive-surface" className="border-border relative mt-4 min-h-0 flex-1 border">
          <p className="p-3 text-xs">Hover keeps the trigger still. Click or press Enter to open. Escape closes.</p>
          <DriveConflictsBar driveId={DRIVE} onOpenFolder={setFolder} />
        </div>
      </main>
    </QueryClientProvider>
  );
}
