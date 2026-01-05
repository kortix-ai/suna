import React from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useDeleteOperation } from '@/stores/delete-operation-store';

export function StatusOverlay() {
  const { state } = useDeleteOperation();

  if (state.operation === 'none' || !state.isDeleting) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-background/90 backdrop-blur p-3 rounded-2xl shadow-lg border border-border">
      {state.operation === 'pending' && (
        <>
          <KortixLoader size="small" />
          <span className="text-sm">Processing...</span>
        </>
      )}

      {state.operation === 'success' && (
        <>
          <CheckCircle className="h-5 w-5 text-green-500" />
          <span className="text-sm">Completed</span>
        </>
      )}

      {state.operation === 'error' && (
        <>
          <AlertCircle className="h-5 w-5 text-destructive" />
          <span className="text-sm">Failed</span>
        </>
      )}
    </div>
  );
}
