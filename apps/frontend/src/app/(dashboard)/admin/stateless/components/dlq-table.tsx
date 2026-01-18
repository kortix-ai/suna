"use client";

import { Loader2, RotateCcw, Trash2, FileWarning, CheckCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DLQEntry } from "@/hooks/admin/use-stateless";

interface DLQTableProps {
  entries: DLQEntry[];
  isLoading: boolean;
  onRetry: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  isRetrying: boolean;
  isDeleting: boolean;
}

export function DLQTable({
  entries,
  isLoading,
  onRetry,
  onDelete,
  isRetrying,
  isDeleting,
}: DLQTableProps) {
  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatAge = (timestamp: number) => {
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const getTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      message: "bg-blue-500/10 text-blue-400 border-blue-500/30",
      credit: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
      status: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    };
    return (
      <Badge className={colors[type] || "bg-muted"}>
        {type}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileWarning className="w-5 h-5 text-red-500" />
          Dead Letter Queue
        </CardTitle>
        <CardDescription>
          Failed writes that exceeded retry limits
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle className="w-12 h-12 text-emerald-500/50 mb-3" />
            <p className="text-muted-foreground">No entries in DLQ</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              All writes have been processed successfully
            </p>
          </div>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="h-10 px-4 text-left text-sm font-medium">Entry ID</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Run ID</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Type</th>
                  <th className="h-10 px-4 text-center text-sm font-medium">Attempts</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Failed</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Error</th>
                  <th className="h-10 px-4 text-center text-sm font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.entry_id} className="border-b">
                    <td className="h-12 px-4 font-mono text-sm">
                      {entry.entry_id.slice(0, 8)}...
                    </td>
                    <td className="h-12 px-4 font-mono text-sm text-muted-foreground">
                      {entry.run_id.slice(0, 8)}...
                    </td>
                    <td className="h-12 px-4">{getTypeBadge(entry.write_type)}</td>
                    <td className="h-12 px-4 text-center">
                      <Badge variant="outline">{entry.attempt_count}</Badge>
                    </td>
                    <td className="h-12 px-4 text-sm text-muted-foreground">
                      {formatAge(entry.failed_at)}
                    </td>
                    <td className="h-12 px-4 text-sm text-red-400 max-w-[200px] truncate">
                      {entry.error}
                    </td>
                    <td className="h-12 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onRetry(entry.entry_id)}
                          disabled={isRetrying || isDeleting}
                          title="Retry"
                        >
                          {isRetrying ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3 h-3" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => onDelete(entry.entry_id)}
                          disabled={isRetrying || isDeleting}
                          title="Delete"
                        >
                          {isDeleting ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
