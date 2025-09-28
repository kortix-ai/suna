import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ThreadErrorProps {
  error: string;
}

export function ThreadError({ error }: ThreadErrorProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
        <div className="rounded-full bg-destructive/10 p-3">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="text-lg font-semibold text-destructive">
          Thread Not Found
        </h2>
        <p className="text-sm text-muted-foreground">
          {error.includes(
            'JSON object requested, multiple (or no) rows returned',
          )
            ? 'This thread either does not exist or you do not have access to it.'
            : error
          }
        </p>
      </div>
    </div>
  );
} 