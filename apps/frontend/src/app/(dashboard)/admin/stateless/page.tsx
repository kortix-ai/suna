"use client";

import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  Zap,
  Server,
  RefreshCw,
  Play,
  Trash2,
  RotateCcw,
  Shield,
  Gauge,
  Database,
  FileWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import {
  useStatelessHealth,
  useStatelessDashboard,
  useStatelessStuckRuns,
  useStatelessDLQ,
  useStatelessCircuitBreakers,
  useStatelessBackpressure,
  useStatelessSweep,
  useStatelessFlush,
  useStatelessForceComplete,
  useStatelessForceFail,
  useStatelessForceResume,
  useStatelessDLQRetry,
  useStatelessDLQDelete,
  useStatelessDLQPurge,
  useStatelessResetCircuitBreakers,
} from "@/hooks/admin/use-stateless";
import { StuckRunsTable } from "./components/stuck-runs-table";
import { DLQTable } from "./components/dlq-table";
import { CircuitBreakersPanel } from "./components/circuit-breakers-panel";
import { BackpressurePanel } from "./components/backpressure-panel";

export default function StatelessAdminPage() {
  const [activeTab, setActiveTab] = useState("overview");

  const { data: health, isLoading: healthLoading } = useStatelessHealth();
  const { data: dashboard, isLoading: dashboardLoading } = useStatelessDashboard();
  const { data: stuckRuns, isLoading: stuckLoading } = useStatelessStuckRuns(5);
  const { data: dlqEntries, isLoading: dlqLoading } = useStatelessDLQ(50);
  const { data: circuitBreakers } = useStatelessCircuitBreakers();
  const { data: backpressure } = useStatelessBackpressure();

  const sweepMutation = useStatelessSweep();
  const flushMutation = useStatelessFlush();
  const forceCompleteMutation = useStatelessForceComplete();
  const forceFailMutation = useStatelessForceFail();
  const forceResumeMutation = useStatelessForceResume();
  const dlqRetryMutation = useStatelessDLQRetry();
  const dlqDeleteMutation = useStatelessDLQDelete();
  const dlqPurgeMutation = useStatelessDLQPurge();
  const resetCircuitBreakersMutation = useStatelessResetCircuitBreakers();

  const handleSweep = () => {
    sweepMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(`Sweep complete: ${data.recovered} recovered, ${data.completed} completed`);
      },
      onError: () => toast.error("Sweep failed"),
    });
  };

  const handleFlush = () => {
    flushMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(`Flushed ${data.total} writes from ${data.runs} runs`);
      },
      onError: () => toast.error("Flush failed"),
    });
  };

  const handleForceComplete = (runId: string) => {
    forceCompleteMutation.mutate({ runId }, {
      onSuccess: () => toast.success(`Run ${runId.slice(0, 8)} completed`),
      onError: () => toast.error("Failed to complete run"),
    });
  };

  const handleForceFail = (runId: string) => {
    forceFailMutation.mutate({ runId, error: "Admin terminated" }, {
      onSuccess: () => toast.success(`Run ${runId.slice(0, 8)} failed`),
      onError: () => toast.error("Failed to fail run"),
    });
  };

  const handleForceResume = (runId: string) => {
    forceResumeMutation.mutate(runId, {
      onSuccess: (data) => toast.success(data.message || `Run ${runId.slice(0, 8)} resumed`),
      onError: () => toast.error("Failed to resume run"),
    });
  };

  const handleDLQRetry = (entryId: string) => {
    dlqRetryMutation.mutate(entryId, {
      onSuccess: () => toast.success("Entry queued for retry"),
      onError: () => toast.error("Retry failed"),
    });
  };

  const handleDLQDelete = (entryId: string) => {
    dlqDeleteMutation.mutate(entryId, {
      onSuccess: () => toast.success("Entry deleted"),
      onError: () => toast.error("Delete failed"),
    });
  };

  const handleDLQPurge = () => {
    dlqPurgeMutation.mutate(24, {
      onSuccess: (data) => toast.success(`Purged ${data.deleted} entries`),
      onError: () => toast.error("Purge failed"),
    });
  };

  const handleResetCircuitBreakers = () => {
    resetCircuitBreakersMutation.mutate(undefined, {
      onSuccess: () => toast.success("Circuit breakers reset"),
      onError: () => toast.error("Reset failed"),
    });
  };

  const isLoading = healthLoading || dashboardLoading;
  const isAnyMutating = sweepMutation.isPending || flushMutation.isPending;

  const getHealthBadge = () => {
    if (!health) return <Badge variant="outline">Unknown</Badge>;
    if (!health.healthy) {
      return (
        <Badge className="bg-red-500/10 text-red-400 border-red-500/30 gap-1.5 px-3 py-1">
          <XCircle className="w-3.5 h-3.5" /> Unhealthy
        </Badge>
      );
    }
    if (dashboard?.alerts && dashboard.alerts.length > 0) {
      return (
        <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1.5 px-3 py-1">
          <AlertTriangle className="w-3.5 h-3.5" /> Warning
        </Badge>
      );
    }
    return (
      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1.5 px-3 py-1">
        <CheckCircle className="w-3.5 h-3.5" /> Healthy
      </Badge>
    );
  };

  const getBackpressureBadge = () => {
    if (!backpressure) return null;
    const colors: Record<string, string> = {
      normal: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
      elevated: "bg-amber-500/10 text-amber-400 border-amber-500/30",
      high: "bg-orange-500/10 text-orange-400 border-orange-500/30",
      critical: "bg-red-500/10 text-red-400 border-red-500/30",
    };
    return (
      <Badge className={`${colors[backpressure.level]} gap-1.5 px-3 py-1`}>
        <Gauge className="w-3.5 h-3.5" /> {backpressure.level.charAt(0).toUpperCase() + backpressure.level.slice(1)}
      </Badge>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="flex-none border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20">
                <Activity className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Stateless Pipeline</h1>
                <p className="text-sm text-muted-foreground">
                  Real-time monitoring and recovery management
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {getBackpressureBadge()}
              {getHealthBadge()}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
          {dashboard?.alerts && dashboard.alerts.length > 0 && (
            <Card className="border-amber-500/30 bg-amber-500/5 backdrop-blur">
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-400">Alerts Detected</p>
                    <ul className="mt-1 space-y-0.5">
                      {dashboard.alerts.map((alert, i) => (
                        <li key={i} className="text-sm text-muted-foreground">
                          • [{alert.level}] {alert.metric}: {alert.value}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Active Runs</p>
                    <p className="text-4xl font-bold tracking-tight mt-1">
                      {isLoading ? "..." : dashboard?.active_runs ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Owned: {dashboard?.owned_runs ?? 0}
                    </p>
                  </div>
                  <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <Server className="w-6 h-6 text-blue-500" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Pending Writes</p>
                    <p className="text-4xl font-bold tracking-tight mt-1">
                      {isLoading ? "..." : dashboard?.pending_writes ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      WAL: {dashboard?.wal?.total_pending ?? 0}
                    </p>
                  </div>
                  <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center">
                    <Database className="w-6 h-6 text-orange-500" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Stuck Runs</p>
                    <p className="text-4xl font-bold tracking-tight mt-1">
                      {isLoading ? "..." : dashboard?.stuck_count ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Recovered: {dashboard?.runs_recovered ?? 0}
                    </p>
                  </div>
                  <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                    <AlertTriangle className="w-6 h-6 text-amber-500" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">DLQ Entries</p>
                    <p className="text-4xl font-bold tracking-tight mt-1">
                      {isLoading ? "..." : dashboard?.dlq?.total_entries ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Runs: {dashboard?.dlq?.unique_runs ?? 0}
                    </p>
                  </div>
                  <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
                    <FileWarning className="w-6 h-6 text-red-500" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Runs Started</p>
                <p className="text-2xl font-bold mt-1">{dashboard?.runs_started ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Runs Completed</p>
                <p className="text-2xl font-bold mt-1 text-emerald-500">{dashboard?.runs_completed ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Runs Failed</p>
                <p className="text-2xl font-bold mt-1 text-red-500">{dashboard?.runs_failed ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Flush Latency (p99)</p>
                <p className="text-2xl font-bold mt-1">
                  {dashboard?.flush_latency_p99?.toFixed(2) ?? 0}
                  <span className="text-sm font-normal text-muted-foreground">s</span>
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary" />
                Quick Actions
              </CardTitle>
              <CardDescription>Emergency controls and maintenance operations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <button
                  onClick={handleSweep}
                  disabled={isAnyMutating}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    {sweepMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                    ) : (
                      <RefreshCw className="w-5 h-5 text-blue-500" />
                    )}
                  </div>
                  <span className="text-sm font-medium">Sweep</span>
                </button>

                <button
                  onClick={handleFlush}
                  disabled={isAnyMutating}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
                    {flushMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin text-orange-500" />
                    ) : (
                      <Play className="w-5 h-5 text-orange-500" />
                    )}
                  </div>
                  <span className="text-sm font-medium">Flush All</span>
                </button>

                <button
                  onClick={handleDLQPurge}
                  disabled={dlqPurgeMutation.isPending}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center">
                    {dlqPurgeMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin text-red-500" />
                    ) : (
                      <Trash2 className="w-5 h-5 text-red-500" />
                    )}
                  </div>
                  <span className="text-sm font-medium">Purge DLQ</span>
                </button>

                <button
                  onClick={handleResetCircuitBreakers}
                  disabled={resetCircuitBreakersMutation.isPending}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    {resetCircuitBreakersMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin text-purple-500" />
                    ) : (
                      <RotateCcw className="w-5 h-5 text-purple-500" />
                    )}
                  </div>
                  <span className="text-sm font-medium">Reset Breakers</span>
                </button>
              </div>
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="stuck">
                Stuck Runs {stuckRuns && stuckRuns.length > 0 && `(${stuckRuns.length})`}
              </TabsTrigger>
              <TabsTrigger value="dlq">
                DLQ {dlqEntries && dlqEntries.length > 0 && `(${dlqEntries.length})`}
              </TabsTrigger>
              <TabsTrigger value="resilience">Resilience</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6 mt-6">
              <div className="grid lg:grid-cols-2 gap-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Worker Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Worker ID</p>
                        <p className="font-mono text-sm">{health?.ownership?.worker_id ?? "-"}</p>
                      </div>
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Initialized</p>
                        <p className="text-sm font-medium">{health?.initialized ? "Yes" : "No"}</p>
                      </div>
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Flusher Running</p>
                        <p className="text-sm font-medium">{health?.flusher?.running ? "Yes" : "No"}</p>
                      </div>
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Recovery Running</p>
                        <p className="text-sm font-medium">{health?.recovery?.running ? "Yes" : "No"}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>WAL Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Total Pending</p>
                        <p className="text-xl font-bold">{dashboard?.wal?.total_pending ?? 0}</p>
                      </div>
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Runs w/ Pending</p>
                        <p className="text-xl font-bold">{dashboard?.wal?.runs_with_pending ?? 0}</p>
                      </div>
                      <div className="p-3 rounded-xl border">
                        <p className="text-xs text-muted-foreground">Local Buffer</p>
                        <p className="text-xl font-bold">{dashboard?.wal?.local_buffer_runs ?? 0}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="stuck" className="mt-6">
              <StuckRunsTable
                runs={stuckRuns ?? []}
                isLoading={stuckLoading}
                onComplete={handleForceComplete}
                onFail={handleForceFail}
                onResume={handleForceResume}
                isCompleting={forceCompleteMutation.isPending}
                isFailing={forceFailMutation.isPending}
                isResuming={forceResumeMutation.isPending}
              />
            </TabsContent>

            <TabsContent value="dlq" className="mt-6">
              <DLQTable
                entries={dlqEntries ?? []}
                isLoading={dlqLoading}
                onRetry={handleDLQRetry}
                onDelete={handleDLQDelete}
                isRetrying={dlqRetryMutation.isPending}
                isDeleting={dlqDeleteMutation.isPending}
              />
            </TabsContent>

            <TabsContent value="resilience" className="space-y-6 mt-6">
              <div className="grid lg:grid-cols-2 gap-6">
                <CircuitBreakersPanel
                  breakers={circuitBreakers ?? {}}
                  onReset={handleResetCircuitBreakers}
                  isResetting={resetCircuitBreakersMutation.isPending}
                />
                <BackpressurePanel backpressure={backpressure} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
