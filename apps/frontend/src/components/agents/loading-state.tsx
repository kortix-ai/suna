import React from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface LoadingStateProps {
  viewMode: 'grid' | 'list';
}

export const LoadingState = ({ viewMode }: LoadingStateProps) => {
  const skeletonCount = viewMode === 'grid' ? 4 : 8;
  
  return (
    <div className={viewMode === 'grid' ? "grid gap-6 sm:grid-cols-2 lg:grid-cols-4" : "space-y-4"}>
      {Array.from({ length: skeletonCount }, (_, i) => (
        <div key={i} className="bg-neutral-100 dark:bg-sidebar border border-border rounded-2xl overflow-hidden">
          <Skeleton className="h-50" />
          <div className="p-4 space-y-3">
            <Skeleton className="h-5 rounded" />
            <div className="space-y-2">
              <Skeleton className="h-4 rounded" />
              <Skeleton className="h-4 rounded w-3/4" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}