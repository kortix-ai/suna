"use client";

import { useState, useMemo } from "react";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Play,
  Search,
  Filter,
  ChevronDown,
  Copy,
  Eye,
  X,
  Timer,
  User,
  Server,
  Square,
  CheckSquare,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
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

const reasonConfig: Record<string, { label: string; color: string; description: string }> = {
  stale_heartbeat: {
    label: "Stale Heartbeat",
    color: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    description: "Worker hasn't sent a heartbeat recently",
  },
  no_heartbeat: {
    label: "No Heartbeat",
    color: "bg-red-500/10 text-red-400 border-red-500/30",
    description: "No heartbeat recorded for this run",
  },
  long_running: {
    label: "Long Running",
    color: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    description: "Run has been active for an unusually long time",
  },
  orphaned: {
    label: "Orphaned",
    color: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    description: "Run has no active owner",
  },
};

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
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [detailRun, setDetailRun] = useState<StuckRun | null>(null);
  const [sortBy, setSortBy] = useState<"duration" | "heartbeat_age">("duration");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Get unique reasons
  const availableReasons = useMemo(() => {
    const reasons = new Set(runs.filter((r) => r.reason).map((r) => r.reason!));
    return Array.from(reasons);
  }, [runs]);

  // Filter and sort
  const filteredRuns = useMemo(() => {
    let result = runs;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          r.run_id.toLowerCase().includes(query) ||
          r.owner?.toLowerCase().includes(query)
      );
    }

    if (selectedReasons.size > 0) {
      result = result.filter((r) => r.reason && selectedReasons.has(r.reason));
    }

    result = [...result].sort((a, b) => {
      const aVal = sortBy === "duration" ? (a.duration || 0) : (a.heartbeat_age || 0);
      const bVal = sortBy === "duration" ? (b.duration || 0) : (b.heartbeat_age || 0);
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    return result;
  }, [runs, searchQuery, selectedReasons, sortBy, sortOrder]);

  // Stats summary
  const stats = useMemo(() => {
    const byReason = new Map<string, number>();
    runs.forEach((r) => {
      if (r.reason) {
        byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
      }
    });
    return {
      total: runs.length,
      byReason: Array.from(byReason.entries()),
      avgDuration: runs.reduce((acc, r) => acc + (r.duration || 0), 0) / (runs.length || 1),
    };
  }, [runs]);

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "-";
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  };

  const getReasonBadge = (reason: string | null) => {
    if (!reason) return <Badge variant="outline">Unknown</Badge>;
    const config = reasonConfig[reason] || {
      label: reason.replace(/_/g, " "),
      color: "bg-muted",
      description: "",
    };
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <Badge className={config.color}>{config.label}</Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">{config.description}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const toggleSelectAll = () => {
    if (selectedRuns.size === filteredRuns.length) {
      setSelectedRuns(new Set());
    } else {
      setSelectedRuns(new Set(filteredRuns.map((r) => r.run_id)));
    }
  };

  const toggleSelectRun = (runId: string) => {
    const newSelected = new Set(selectedRuns);
    if (newSelected.has(runId)) {
      newSelected.delete(runId);
    } else {
      newSelected.add(runId);
    }
    setSelectedRuns(newSelected);
  };

  const getDurationSeverity = (seconds: number | null) => {
    if (!seconds) return "text-muted-foreground";
    if (seconds < 300) return "text-muted-foreground";
    if (seconds < 1800) return "text-amber-500";
    return "text-red-500";
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                Stuck Runs
              </CardTitle>
              <CardDescription className="mt-1">
                Runs that appear to be stuck or orphaned • {runs.length} total
              </CardDescription>
            </div>

            {/* Stats Summary */}
            {stats.byReason.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {stats.byReason.map(([reason, count]) => (
                  <Badge
                    key={reason}
                    variant="outline"
                    className="text-xs cursor-pointer hover:bg-muted"
                    onClick={() => {
                      const newReasons = new Set(selectedReasons);
                      if (newReasons.has(reason)) {
                        newReasons.delete(reason);
                      } else {
                        newReasons.add(reason);
                      }
                      setSelectedReasons(newReasons);
                    }}
                  >
                    {reasonConfig[reason]?.label || reason}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 mt-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by run ID or owner..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
                  <Filter className="w-4 h-4" />
                  Reason
                  {selectedReasons.size > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedReasons.size}
                    </Badge>
                  )}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>Filter by reason</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableReasons.map((reason) => (
                  <DropdownMenuCheckboxItem
                    key={reason}
                    checked={selectedReasons.has(reason)}
                    onCheckedChange={(checked) => {
                      const newReasons = new Set(selectedReasons);
                      if (checked) {
                        newReasons.add(reason);
                      } else {
                        newReasons.delete(reason);
                      }
                      setSelectedReasons(newReasons);
                    }}
                  >
                    {reasonConfig[reason]?.label || reason}
                  </DropdownMenuCheckboxItem>
                ))}
                {selectedReasons.size > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setSelectedReasons(new Set())}>
                      Clear filters
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
                  Sort
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => { setSortBy("duration"); setSortOrder("desc"); }}>
                  Longest duration
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSortBy("heartbeat_age"); setSortOrder("desc"); }}>
                  Oldest heartbeat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSortBy("duration"); setSortOrder("asc"); }}>
                  Shortest duration
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Bulk Actions */}
            {selectedRuns.size > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm text-muted-foreground">
                  {selectedRuns.size} selected
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    selectedRuns.forEach((id) => onResume(id));
                    setSelectedRuns(new Set());
                  }}
                  disabled={isResuming}
                  className="h-9"
                >
                  <Play className="w-4 h-4 mr-1.5" />
                  Resume All
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    selectedRuns.forEach((id) => onComplete(id));
                    setSelectedRuns(new Set());
                  }}
                  disabled={isCompleting}
                  className="h-9 text-emerald-500"
                >
                  <CheckCircle className="w-4 h-4 mr-1.5" />
                  Complete All
                </Button>
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-500/50 mb-3" />
              <p className="text-muted-foreground font-medium">
                {runs.length === 0 ? "No stuck runs detected" : "No runs match filters"}
              </p>
              {runs.length === 0 && (
                <p className="text-sm text-muted-foreground/70 mt-1">
                  All runs are operating normally
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y bg-muted/50">
                    <th className="h-11 px-4 text-left">
                      <button onClick={toggleSelectAll} className="flex items-center justify-center">
                        {selectedRuns.size === filteredRuns.length ? (
                          <CheckSquare className="w-4 h-4 text-primary" />
                        ) : (
                          <Square className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Run ID
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Owner
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Status
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Reason
                    </th>
                    <th className="h-11 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Duration
                    </th>
                    <th className="h-11 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      HB Age
                    </th>
                    <th className="h-11 px-4 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRuns.map((run) => (
                    <tr
                      key={run.run_id}
                      className={cn(
                        "border-b transition-colors hover:bg-muted/30",
                        selectedRuns.has(run.run_id) && "bg-primary/5"
                      )}
                    >
                      <td className="h-14 px-4">
                        <button onClick={() => toggleSelectRun(run.run_id)} className="flex items-center justify-center">
                          {selectedRuns.has(run.run_id) ? (
                            <CheckSquare className="w-4 h-4 text-primary" />
                          ) : (
                            <Square className="w-4 h-4 text-muted-foreground" />
                          )}
                        </button>
                      </td>
                      <td className="h-14 px-4">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => copyToClipboard(run.run_id)}
                                className="font-mono text-sm hover:text-primary transition-colors"
                              >
                                {run.run_id.slice(0, 8)}...
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="font-mono text-xs">{run.run_id}</p>
                              <p className="text-xs text-muted-foreground mt-1">Click to copy</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>
                      <td className="h-14 px-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          <User className="w-3.5 h-3.5" />
                          {run.owner ? run.owner.slice(0, 8) : "-"}
                        </span>
                      </td>
                      <td className="h-14 px-4">
                        <Badge variant="outline">{run.status || "unknown"}</Badge>
                      </td>
                      <td className="h-14 px-4">{getReasonBadge(run.reason)}</td>
                      <td className="h-14 px-4 text-right">
                        <span className={cn("font-mono text-sm flex items-center justify-end gap-1.5", getDurationSeverity(run.duration))}>
                          <Timer className="w-3.5 h-3.5" />
                          {formatDuration(run.duration)}
                        </span>
                      </td>
                      <td className="h-14 px-4 text-right">
                        <span className="font-mono text-sm text-muted-foreground flex items-center justify-end gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          {formatDuration(run.heartbeat_age)}
                        </span>
                      </td>
                      <td className="h-14 px-4">
                        <div className="flex items-center justify-center gap-1.5">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  onClick={() => setDetailRun(run)}
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>View details</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-blue-500 hover:text-blue-600"
                                  onClick={() => onResume(run.run_id)}
                                  disabled={isCompleting || isFailing || isResuming}
                                >
                                  {isResuming ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Play className="w-4 h-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Resume run</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-emerald-500 hover:text-emerald-600"
                                  onClick={() => onComplete(run.run_id)}
                                  disabled={isCompleting || isFailing || isResuming}
                                >
                                  {isCompleting ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <CheckCircle className="w-4 h-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Mark complete</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-500 hover:text-red-600"
                                  onClick={() => onFail(run.run_id)}
                                  disabled={isCompleting || isFailing || isResuming}
                                >
                                  {isFailing ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <XCircle className="w-4 h-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Mark failed</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
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

      {/* Detail Modal */}
      <Dialog open={!!detailRun} onOpenChange={() => setDetailRun(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="w-5 h-5 text-amber-500" />
              Stuck Run Details
            </DialogTitle>
            <DialogDescription>
              Information about this potentially stuck run
            </DialogDescription>
          </DialogHeader>

          {detailRun && (
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Run ID
                </label>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono bg-muted px-2 py-1 rounded flex-1 truncate">
                    {detailRun.run_id}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => copyToClipboard(detailRun.run_id)}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Owner
                  </label>
                  <p className="text-sm font-mono">{detailRun.owner || "None"}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Status
                  </label>
                  <Badge variant="outline">{detailRun.status || "unknown"}</Badge>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Reason
                  </label>
                  {getReasonBadge(detailRun.reason)}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Duration
                  </label>
                  <p className={cn("text-sm font-mono", getDurationSeverity(detailRun.duration))}>
                    {formatDuration(detailRun.duration)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Heartbeat Age
                  </label>
                  <p className="text-sm font-mono">{formatDuration(detailRun.heartbeat_age)}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Last Heartbeat
                  </label>
                  <p className="text-sm">
                    {detailRun.heartbeat
                      ? new Date(detailRun.heartbeat * 1000).toLocaleString()
                      : "Never"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-4 border-t">
                <Button
                  onClick={() => {
                    onResume(detailRun.run_id);
                    setDetailRun(null);
                  }}
                  disabled={isResuming}
                  className="flex-1"
                >
                  {isResuming ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2" />
                  )}
                  Resume
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-emerald-500 hover:text-emerald-600"
                  onClick={() => {
                    onComplete(detailRun.run_id);
                    setDetailRun(null);
                  }}
                  disabled={isCompleting}
                >
                  {isCompleting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4 mr-2" />
                  )}
                  Complete
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-red-500 hover:text-red-600"
                  onClick={() => {
                    onFail(detailRun.run_id);
                    setDetailRun(null);
                  }}
                  disabled={isFailing}
                >
                  {isFailing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="w-4 h-4 mr-2" />
                  )}
                  Fail
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
