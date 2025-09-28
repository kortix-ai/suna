import React from 'react';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useDeleteOperation } from '@/contexts/DeleteOperationContext';

export function StatusOverlay() {
  const { state } = useDeleteOperation();

  if (state.operation === 'none' || !state.isDeleting) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-background/90 backdrop-blur p-3 rounded-lg shadow-lg border border-border">
      {state.operation === 'pending' && (
        <>
          <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
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
