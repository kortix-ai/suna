'use client';

/**
 * TunnelAuditTable — paginated audit log viewer for tunnel operations.
 */

import React, { useState } from 'react';
import { CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTunnelAuditLogs } from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';

interface TunnelAuditTableProps {
  tunnelId: string;
}

export function TunnelAuditTable({ tunnelId }: TunnelAuditTableProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useTunnelAuditLogs(tunnelId, page);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading audit logs...</div>;
  }

  if (!data || data.data.length === 0) {
    return <div className="text-sm text-muted-foreground">No audit logs yet.</div>;
  }

  const { data: logs, pagination } = data;

  return (
    <div className="space-y-3">
      {/* Log Entries */}
      <div className="space-y-1.5">
        {logs.map((log) => (
          <div
            key={log.logId}
            className={cn(
              'flex items-center gap-3 rounded-2xl border px-3 py-2 text-sm',
              log.success ? 'border-border' : 'border-red-500/20 bg-red-500/5',
            )}
          >
            {/* Status Icon */}
            {log.success ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 text-red-500 shrink-0" />
            )}

            {/* Operation */}
            <div className="flex-1 min-w-0">
              <span className="font-mono text-xs">{log.operation}</span>
              {log.durationMs && (
                <span className="ml-2 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3 inline mr-0.5" />
                  {log.durationMs}ms
                </span>
              )}
            </div>

            {/* Capability Badge */}
            <Badge variant="secondary" className="text-xs shrink-0">
              {log.capability}
            </Badge>

            {/* Timestamp */}
            <span className="text-xs text-muted-foreground shrink-0">
              {new Date(log.createdAt).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
