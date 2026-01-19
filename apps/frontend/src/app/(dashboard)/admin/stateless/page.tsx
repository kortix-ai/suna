"use client";

import { useState, useMemo, useEffect } from "react";
import {
  Activity,
  AlertTriangle,
  Server,
  Database,
  FileWarning,
  Loader2,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
  BarChart3,
  Settings,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import {
  useStatelessHealth,
  useStatelessDashboard,
  useStatelessStuckRuns,
  useStatelessDLQ,
  useStatelessCircuitBreakers,
  useStatelessBackpressure,
  useStatelessRateLimiters,
  useStatelessMetricsHistory,
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
import {
  StatCard,
  StatCardGrid,
  MetricsChart,
  DonutChart,
  DLQTable,
  StuckRunsTable,
  SystemHealthPanel,
  HealthBadges,
  QuickActions,
  CircuitBreakersPanel,
  BackpressurePanel,
  RateLimitersPanel,
  RunLookup,
} from "./components";

// Format metrics history for charts
function formatMetricsHistory(history: Array<{
  timestamp: number;
  active_runs: number;
  pending_writes: number;
  runs_started: number;
  runs_completed: number;
  runs_failed: number;
  flush_latency_avg: number;
  flush_latency_p99: number;
  writes_dropped: number;
  dlq_entries: number;
}>) {
  return history.map((entry) => {
    const date = new Date(entry.timestamp * 1000);
    return {
      time: date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      activeRuns: entry.active_runs,
      pendingWrites: entry.pending_writes,
      runsStarted: entry.runs_started,
      runsCompleted: entry.runs_completed,
      runsFailed: entry.runs_failed,
      latencyAvg: entry.flush_latency_avg * 1000, // Convert to ms
      latencyP99: entry.flush_latency_p99 * 1000,
      writesDropped: entry.writes_dropped,
      dlqEntries: entry.dlq_entries,
    };
  });
}

export default function StatelessAdminPage() {
  const [activeTab, setActiveTab] = useState("overview");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Data hooks
  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = useStatelessHealth();
  const { data: dashboard, isLoading: dashboardLoading, refetch: refetchDashboard } = useStatelessDashboard();
  const { data: stuckRuns, isLoading: stuckLoading, refetch: refetchStuck } = useStatelessStuckRuns(5);
  const { data: dlqEntries, isLoading: dlqLoading, refetch: refetchDlq } = useStatelessDLQ(100);
  const { data: circuitBreakers, refetch: refetchBreakers } = useStatelessCircuitBreakers();
  const { data: backpressure, refetch: refetchBackpressure } = useStatelessBackpressure();
  const { data: rateLimiters, refetch: refetchRateLimiters } = useStatelessRateLimiters();
  const { data: metricsHistory, refetch: refetchMetrics } = useStatelessMetricsHistory(30);

  const sweepMutation = useStatelessSweep();
  const flushMutation = useStatelessFlush();
  const forceCompleteMutation = useStatelessForceComplete();
  const forceFailMutation = useStatelessForceFail();
  const forceResumeMutation = useStatelessForceResume();
  const dlqRetryMutation = useStatelessDLQRetry();
  const dlqDeleteMutation = useStatelessDLQDelete();
  const dlqPurgeMutation = useStatelessDLQPurge();
  const resetCircuitBreakersMutation = useStatelessResetCircuitBreakers();

  const history = useMemo(() => {
    return formatMetricsHistory(metricsHistory?.history || []);
  }, [metricsHistory]);

  const handleRefreshAll = () => {
    refetchHealth();
    refetchDashboard();
    refetchStuck();
    refetchDlq();
    refetchBreakers();
    refetchBackpressure();
    refetchRateLimiters();
    refetchMetrics();
    setLastRefresh(new Date());
    toast.success("Data refreshed");
  };

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
      onSuccess: () => toast.success(`Run ${runId.slice(0, 8)}... completed`),
      onError: () => toast.error("Failed to complete run"),
    });
  };

  const handleForceFail = (runId: string) => {
    forceFailMutation.mutate({ runId, error: "Admin terminated" }, {
      onSuccess: () => toast.success(`Run ${runId.slice(0, 8)}... failed`),
      onError: () => toast.error("Failed to fail run"),
    });
  };

  const handleForceResume = (runId: string) => {
    forceResumeMutation.mutate(runId, {
      onSuccess: (data) => toast.success(data.message || `Run ${runId.slice(0, 8)}... resumed`),
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

  const handleDLQPurge = (hours?: number) => {
    dlqPurgeMutation.mutate(hours ? hours * 3600 : undefined, {
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

  // Computed values
  const isLoading = healthLoading || dashboardLoading;
  const alertCount = dashboard?.alerts?.length ?? 0;

  // DLQ error distribution for chart
  const dlqErrorDistribution = useMemo(() => {
    if (!dlqEntries) return [];
    const errorCounts = new Map<string, number>();
    dlqEntries.forEach((entry) => {
      const errorType = extractErrorType(entry.error);
      errorCounts.set(errorType, (errorCounts.get(errorType) || 0) + 1);
    });
    const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6"];
    return Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value], i) => ({
        name,
        value,
        color: colors[i % colors.length],
      }));
  }, [dlqEntries]);

  // Run stats for pie chart
  const runStats = useMemo(() => {
    if (!dashboard) return [];
    return [
      { name: "Completed", value: dashboard.runs_completed || 0, color: "#10b981" },
      { name: "Failed", value: dashboard.runs_failed || 0, color: "#ef4444" },
      { name: "Active", value: dashboard.active_runs || 0, color: "#3b82f6" },
      { name: "Stuck", value: dashboard.stuck_count || 0, color: "#f59e0b" },
    ].filter((s) => s.value > 0);
  }, [dashboard]);

  // Sparkline data for stat cards
  const sparklineData = useMemo(() => ({
    activeRuns: history.map((h) => h.activeRuns),
    pendingWrites: history.map((h) => h.pendingWrites),
    completed: history.map((h) => h.runsCompleted),
    failed: history.map((h) => h.runsFailed),
    latency: history.map((h) => h.latencyP99),
  }), [history]);

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="flex-none bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20">
                <Activity className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Monitoring</h1>
                <p className="text-sm text-muted-foreground">
                  Real-time monitoring, debugging, and recovery management
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <HealthBadges health={health} backpressure={backpressure} alertCount={alertCount} />
            </div>
          </div>
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
            <QuickActions
              onSweep={handleSweep}
              onFlush={handleFlush}
              onPurgeDLQ={handleDLQPurge}
              onResetBreakers={handleResetCircuitBreakers}
              isSweeping={sweepMutation.isPending}
              isFlushing={flushMutation.isPending}
              isPurging={dlqPurgeMutation.isPending}
              isResetting={resetCircuitBreakersMutation.isPending}
            />
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {lastRefresh.toLocaleTimeString()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefreshAll}
                disabled={isLoading}
                className="gap-1.5 h-8"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
          {dashboard?.alerts && dashboard.alerts.length > 0 && (
            <Card className="border-amber-500/30 bg-amber-500/5 backdrop-blur">
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium text-amber-400">
                      {dashboard.alerts.length} Alert{dashboard.alerts.length > 1 ? "s" : ""} Detected
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {dashboard.alerts.map((alert, i) => (
                        <Badge
                          key={i}
                          variant="outline"
                          className={
                            alert.level === "critical"
                              ? "border-red-500/50 text-red-400"
                              : "border-amber-500/50 text-amber-400"
                          }
                        >
                          {alert.metric}: {typeof alert.value === "number" ? alert.value.toLocaleString() : alert.value}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Stats Cards */}
          <StatCardGrid columns={4}>
            <StatCard
              title="Active Runs"
              value={isLoading ? "..." : (dashboard?.active_runs ?? 0).toLocaleString()}
              subtitle={`Owned: ${dashboard?.owned_runs ?? 0}`}
              icon={<Server className="w-6 h-6" />}
              variant="info"
              sparklineData={sparklineData.activeRuns}
            />
            <StatCard
              title="Pending Writes"
              value={isLoading ? "..." : (dashboard?.pending_writes ?? 0).toLocaleString()}
              subtitle={`WAL: ${dashboard?.wal?.total_pending ?? 0}`}
              icon={<Database className="w-6 h-6" />}
              variant={(dashboard?.pending_writes ?? 0) > 100 ? "warning" : "default"}
              sparklineData={sparklineData.pendingWrites}
            />
            <StatCard
              title="Stuck Runs"
              value={isLoading ? "..." : (dashboard?.stuck_count ?? 0).toLocaleString()}
              subtitle={`Recovered: ${dashboard?.runs_recovered ?? 0}`}
              icon={<AlertTriangle className="w-6 h-6" />}
              variant={(dashboard?.stuck_count ?? 0) > 0 ? "warning" : "success"}
            />
            <StatCard
              title="DLQ Entries"
              value={isLoading ? "..." : (dashboard?.dlq?.total_entries ?? 0).toLocaleString()}
              subtitle={`Runs affected: ${dashboard?.dlq?.unique_runs ?? 0}`}
              icon={<FileWarning className="w-6 h-6" />}
              variant={(dashboard?.dlq?.total_entries ?? 0) > 0 ? "danger" : "success"}
            />
          </StatCardGrid>
          <StatCardGrid columns={4}>
            <StatCard
              title="Runs Started"
              value={(dashboard?.runs_started ?? 0).toLocaleString()}
              icon={<TrendingUp className="w-5 h-5" />}
              size="compact"
            />
            <StatCard
              title="Runs Completed"
              value={(dashboard?.runs_completed ?? 0).toLocaleString()}
              icon={<CheckCircle className="w-5 h-5" />}
              variant="success"
              size="compact"
              sparklineData={sparklineData.completed}
            />
            <StatCard
              title="Runs Failed"
              value={(dashboard?.runs_failed ?? 0).toLocaleString()}
              icon={<XCircle className="w-5 h-5" />}
              variant={(dashboard?.runs_failed ?? 0) > 0 ? "danger" : "default"}
              size="compact"
              sparklineData={sparklineData.failed}
            />
            <StatCard
              title="Flush Latency (p99)"
              value={`${(dashboard?.flush_latency_p99 ?? 0).toFixed(2)}s`}
              icon={<Clock className="w-5 h-5" />}
              variant={(dashboard?.flush_latency_p99 ?? 0) > 5 ? "warning" : "default"}
              size="compact"
              sparklineData={sparklineData.latency}
            />
          </StatCardGrid>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="h-9">
              <TabsTrigger value="overview" className="gap-1.5 text-sm px-3">
                Overview
              </TabsTrigger>
              <TabsTrigger value="stuck" className="gap-1.5 text-sm px-3">
                Stuck Runs
                {stuckRuns && stuckRuns.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                    {stuckRuns.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="dlq" className="gap-1.5 text-sm px-3">
                DLQ
                {dlqEntries && dlqEntries.length > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs">
                    {dlqEntries.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="resilience" className="gap-1.5 text-sm px-3">
                Resilience
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-6 space-y-6">
              {/* Activity & Latency Charts */}
              <div className="grid lg:grid-cols-2 gap-6">
                <MetricsChart
                  title="Pipeline Activity"
                  description="Active runs and pending writes over time"
                  data={history}
                  dataKeys={[
                    { key: "activeRuns", label: "Active Runs", color: "#3b82f6" },
                    { key: "pendingWrites", label: "Pending Writes", color: "#f59e0b" },
                  ]}
                  xAxisKey="time"
                  type="area"
                  height={240}
                  isLoading={isLoading}
                  emptyMessage="Collecting metrics... (updates every 15s)"
                />

                <MetricsChart
                  title="Flush Latency"
                  description="P99 latency trend in milliseconds"
                  data={history}
                  dataKeys={[
                    { key: "latencyP99", label: "P99 Latency (ms)", color: "#8b5cf6" },
                    { key: "latencyAvg", label: "Avg Latency (ms)", color: "#a1a1aa" },
                  ]}
                  xAxisKey="time"
                  type="line"
                  height={240}
                  isLoading={isLoading}
                  emptyMessage="Collecting metrics..."
                />
              </div>

              {/* Throughput & Errors */}
              <div className="grid lg:grid-cols-2 gap-6">
                <MetricsChart
                  title="Run Throughput"
                  description="Cumulative runs completed and failed"
                  data={history}
                  dataKeys={[
                    { key: "runsCompleted", label: "Completed", color: "#10b981" },
                    { key: "runsFailed", label: "Failed", color: "#ef4444" },
                  ]}
                  xAxisKey="time"
                  type="area"
                  stacked
                  height={240}
                  isLoading={isLoading}
                  emptyMessage="Collecting metrics..."
                />

                <DonutChart
                  title="Run Status Distribution"
                  description="Current state of all runs"
                  data={runStats}
                  height={180}
                  isLoading={isLoading}
                  centerValue={dashboard?.runs_started || 0}
                  centerLabel="Total"
                />
              </div>

              {/* System Health & DLQ */}
              <div className="grid lg:grid-cols-2 gap-6">
                <SystemHealthPanel
                  health={health}
                  backpressure={backpressure}
                  isLoading={isLoading}
                />

                {dlqErrorDistribution.length > 0 ? (
                  <DonutChart
                    title="DLQ Error Distribution"
                    description="Types of errors in dead letter queue"
                    data={dlqErrorDistribution}
                    height={180}
                    isLoading={dlqLoading}
                    centerValue={dlqEntries?.length || 0}
                    centerLabel="Errors"
                  />
                ) : (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">DLQ Error Distribution</CardTitle>
                      <CardDescription>Types of errors in dead letter queue</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center justify-center h-[180px] text-center">
                      <CheckCircle className="w-10 h-10 text-emerald-500/50 mb-2" />
                      <p className="text-sm text-muted-foreground">No DLQ entries</p>
                    </CardContent>
                  </Card>
                )}
              </div>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Database className="w-5 h-5 text-primary" />
                    Write-Ahead Log Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 rounded-xl bg-muted/50 border">
                      <p className="text-sm text-muted-foreground">Total Pending</p>
                      <p className="text-3xl font-bold mt-1">{dashboard?.wal?.total_pending ?? 0}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-muted/50 border">
                      <p className="text-sm text-muted-foreground">Runs with Pending</p>
                      <p className="text-3xl font-bold mt-1">{dashboard?.wal?.runs_with_pending ?? 0}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-muted/50 border">
                      <p className="text-sm text-muted-foreground">Local Buffer Runs</p>
                      <p className="text-3xl font-bold mt-1">{dashboard?.wal?.local_buffer_runs ?? 0}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Stuck Runs Tab */}
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

            {/* DLQ Tab */}
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

            {/* Resilience Tab */}
            <TabsContent value="resilience" className="mt-6 space-y-6">
              <div className="grid lg:grid-cols-2 gap-6">
                <CircuitBreakersPanel
                  breakers={circuitBreakers ?? {}}
                  onReset={handleResetCircuitBreakers}
                  isResetting={resetCircuitBreakersMutation.isPending}
                />
                <BackpressurePanel backpressure={backpressure} />
              </div>
              <div className="grid lg:grid-cols-2 gap-6">
                <RateLimitersPanel limiters={rateLimiters ?? {}} />
                <RunLookup />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function extractErrorType(error: string): string {
  const match = error.match(/([a-zA-Z]+\.errors\.[a-zA-Z]+)/);
  if (match) return match[1].split(".").pop() || error.slice(0, 20);
  const pyMatch = error.match(/^([A-Z][a-zA-Z]+Error|[A-Z][a-zA-Z]+Exception)/);
  if (pyMatch) return pyMatch[1];
  return error.slice(0, 20) + (error.length > 20 ? "..." : "");
}
