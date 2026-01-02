'use client';

import React from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { useDeleteOperation } from '@/stores/delete-operation-store';
import { KortixLoader } from '@/components/ui/kortix-loader';

export function StatusOverlay() {
  const { state } = useDeleteOperation();

  if (state.operation === 'none' || !state.isDeleting) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 bg-background/95 backdrop-blur-sm px-4 py-2.5 rounded-full shadow-lg border border-border">
      {state.operation === 'pending' && (
        <>
          <KortixLoader size="small" customSize={16} />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Working</span>
        </>
      )}

      {state.operation === 'success' && (
        <>
          <CheckCircle className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Done</span>
        </>
      )}

      {state.operation === 'error' && (
        <>
          <AlertCircle className="h-4 w-4 text-destructive" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Failed</span>
        </>
      )}
    </div>
  );
}
