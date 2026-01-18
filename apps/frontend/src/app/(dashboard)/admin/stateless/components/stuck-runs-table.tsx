"use client";

import { Loader2, CheckCircle, XCircle, Clock, AlertTriangle, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { StuckRun } from "@/hooks/admin/use-stateless";

interface StuckRunsTableProps {
  runs: StuckRun[];
  isLoading: boolean;
  onComplete: (runId: string) => void;
  onFail: (runId: string) => void;
  onResume: (runId: string) => void;
  isCompleting: boolean;
  isFailing: boolean;
  isResuming: boolean;
}

export function StuckRunsTable({
  runs,
  isLoading,
  onComplete,
  onFail,
  onResume,
  isCompleting,
  isFailing,
  isResuming,
}: StuckRunsTableProps) {
  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "-";
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const getReasonBadge = (reason: string | null) => {
    if (!reason) return <Badge variant="outline">Unknown</Badge>;
    const colors: Record<string, string> = {
      stale_heartbeat: "bg-amber-500/10 text-amber-400 border-amber-500/30",
      no_heartbeat: "bg-red-500/10 text-red-400 border-red-500/30",
      long_running: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    };
    return (
      <Badge className={colors[reason] || "bg-muted"}>
        {reason.replace(/_/g, " ")}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          Stuck Runs
        </CardTitle>
        <CardDescription>
          Runs that appear to be stuck or orphaned
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle className="w-12 h-12 text-emerald-500/50 mb-3" />
            <p className="text-muted-foreground">No stuck runs detected</p>
          </div>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="h-10 px-4 text-left text-sm font-medium">Run ID</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Owner</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Status</th>
                  <th className="h-10 px-4 text-left text-sm font-medium">Reason</th>
                  <th className="h-10 px-4 text-right text-sm font-medium">Duration</th>
                  <th className="h-10 px-4 text-right text-sm font-medium">HB Age</th>
                  <th className="h-10 px-4 text-center text-sm font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.run_id} className="border-b">
                    <td className="h-12 px-4 font-mono text-sm">
                      {run.run_id.slice(0, 8)}...
                    </td>
                    <td className="h-12 px-4 text-sm text-muted-foreground">
                      {run.owner || "-"}
                    </td>
                    <td className="h-12 px-4">
                      <Badge variant="outline">{run.status || "unknown"}</Badge>
                    </td>
                    <td className="h-12 px-4">{getReasonBadge(run.reason)}</td>
                    <td className="h-12 px-4 text-right font-mono text-sm">
                      {formatDuration(run.duration)}
                    </td>
                    <td className="h-12 px-4 text-right font-mono text-sm">
                      {formatDuration(run.heartbeat_age)}
                    </td>
                    <td className="h-12 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-emerald-500 hover:text-emerald-600"
                          onClick={() => onResume(run.run_id)}
                          disabled={isCompleting || isFailing || isResuming}
                          title="Resume run"
                        >
                          {isResuming ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onComplete(run.run_id)}
                          disabled={isCompleting || isFailing || isResuming}
                          title="Mark as complete"
                        >
                          {isCompleting ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <CheckCircle className="w-3 h-3" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => onFail(run.run_id)}
                          disabled={isCompleting || isFailing || isResuming}
                          title="Mark as failed"
                        >
                          {isFailing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <XCircle className="w-3 h-3" />
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
