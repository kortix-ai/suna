'use client';

import { useTranslations } from 'next-intl';

/**
 * TunnelAuditTable — paginated audit log viewer for tunnel operations.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTunnelAuditLogs } from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';
import {
  CheckCircleIcon as CheckCircle2,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  ClockIcon as Clock,
  XCircleIcon as XCircle,
} from '@phosphor-icons/react';
import { useState } from 'react';

interface TunnelAuditTableProps {
  tunnelId: string;
}

// Hoisted so render does not rebuild a formatter per row. Options mirror the
// spec defaults of `Date.prototype.toLocaleTimeString()` (numeric time), so
// output is byte-identical to the previous inline call.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export function TunnelAuditTable({ tunnelId }: TunnelAuditTableProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useTunnelAuditLogs(tunnelId, page);

  if (isLoading) {
    return (
      <div className="text-muted-foreground text-sm">
        {tHardcodedUi.raw('componentsTunnelTunnelAuditTable.line23JsxTextLoadingAuditLogs')}
      </div>
    );
  }

  if (!data || data.data.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        {tHardcodedUi.raw('componentsTunnelTunnelAuditTable.line27JsxTextNoAuditLogsYet')}
      </div>
    );
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
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 text-red-500" />
            )}

            {/* Operation */}
            <div className="min-w-0 flex-1">
              <span className="font-mono text-xs">{log.operation}</span>
              {log.durationMs && (
                <span className="text-muted-foreground ml-2 text-xs">
                  <Clock className="mr-0.5 inline h-3 w-3" />
                  {log.durationMs}ms
                </span>
              )}
            </div>

            {/* Capability Badge */}
            <Badge variant="secondary" className="shrink-0 text-xs">
              {log.capability}
            </Badge>

            {/* Timestamp */}
            <span className="text-muted-foreground shrink-0 text-xs">
              {TIME_FORMAT.format(new Date(log.createdAt))}
            </span>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-muted-foreground text-xs">
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
