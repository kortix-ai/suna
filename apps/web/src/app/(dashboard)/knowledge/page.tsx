import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { KnowledgePage } from '@/components/knowledge/knowledge-page';

export const metadata = { title: 'Knowledge — Kortix' };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-full w-full" />}>
      <KnowledgePage />
    </Suspense>
  );
}
