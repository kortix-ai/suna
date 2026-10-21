'use client';

import { useMatter } from '@/components/access';
import { HistoryList } from '@/components/runs/history-list';
import { api } from '@convex/_generated/api';
import { useQuery } from 'convex/react';

export default function HistoryPage() {
  const { matter } = useMatter();
  const items = useQuery(api.workflows.history, { matterId: matter._id });
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h2 className="text-sm font-medium">History</h2>
        <p className="text-xs text-muted-foreground">Every run and conversation on this matter, newest first.</p>
      </div>
      <HistoryList items={items} empty="Runs and conversations on this matter appear here." />
    </div>
  );
}
