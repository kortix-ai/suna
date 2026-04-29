import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentsPanel } from '@/components/agents/AgentsPanel';

export const metadata = {
  title: 'Agents — Kortix',
};

export default function AgentsPage() {
  return (
    <Suspense fallback={<AgentsPanelSkeleton />}>
      <AgentsPanel />
    </Suspense>
  );
}

function AgentsPanelSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-10 w-full" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}
