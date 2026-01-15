"use client";

import { useState } from "react";
import { 
  Box, 
  RefreshCw, 
  Plus, 
  Trash2, 
  Play, 
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  useSandboxPoolHealth,
  useSandboxPoolStats,
  useSandboxPoolList,
  useSandboxPoolReplenish,
  useSandboxPoolForceCreate,
  useSandboxPoolCleanup,
  useSandboxPoolRestart,
} from "@/hooks/admin/use-sandbox-pool";

export default function SandboxPoolAdminPage() {
  const [createCount, setCreateCount] = useState(1);

  const { data: health, isLoading: healthLoading } = useSandboxPoolHealth();
  const { data: stats, isLoading: statsLoading } = useSandboxPoolStats();
  const { data: sandboxes, isLoading: sandboxesLoading } = useSandboxPoolList(50);

  const replenishMutation = useSandboxPoolReplenish();
  const forceCreateMutation = useSandboxPoolForceCreate();
  const cleanupMutation = useSandboxPoolCleanup();
  const restartMutation = useSandboxPoolRestart();

  const handleReplenish = () => {
    replenishMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(`Created ${data.sandboxes_created} sandboxes. Pool size: ${data.pool_size_after}`);
      },
      onError: () => {
        toast.error("Failed to replenish pool");
      },
    });
  };

  const handleForceCreate = () => {
    forceCreateMutation.mutate(createCount, {
      onSuccess: (data) => {
        toast.success(`Created ${data.created_count}/${data.requested} sandboxes. Pool size: ${data.pool_size_after}`);
        if (data.failed_count > 0) {
          toast.error(`${data.failed_count} sandboxes failed to create`);
        }
      },
      onError: () => {
        toast.error("Failed to create sandboxes");
      },
    });
  };

  const handleCleanup = () => {
    cleanupMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(`Cleaned up ${data.cleaned_count} stale sandboxes`);
      },
      onError: () => {
        toast.error("Failed to cleanup pool");
      },
    });
  };

  const handleRestart = () => {
    restartMutation.mutate(undefined, {
      onSuccess: (data) => {
        if (data.is_running) {
          toast.success("Pool service restarted successfully");
        } else {
          toast.error("Failed to restart pool service");
        }
      },
      onError: () => {
        toast.error("Failed to restart pool service");
      },
    });
  };

  const getHealthBadge = (status: string) => {
    switch (status) {
      case "healthy":
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20"><CheckCircle className="w-3 h-3 mr-1" /> Healthy</Badge>;
      case "warning":
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20"><AlertTriangle className="w-3 h-3 mr-1" /> Warning</Badge>;
      case "critical":
        return <Badge className="bg-red-500/10 text-red-500 border-red-500/20"><XCircle className="w-3 h-3 mr-1" /> Critical</Badge>;
      case "disabled":
        return <Badge variant="secondary">Disabled</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const isLoading = healthLoading || statsLoading;
  const isAnyMutating = replenishMutation.isPending || forceCreateMutation.isPending || cleanupMutation.isPending || restartMutation.isPending;

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-none">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10">
                <Box className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Sandbox Pool</h1>
                <p className="text-sm text-muted-foreground">
                  Manage pre-warmed sandbox pool for disaster recovery
                </p>
              </div>
            </div>
            {health && getHealthBadge(health.status)}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
          {/* Health Issues */}
          {health?.issues && health.issues.length > 0 && (
            <Card className="border-yellow-500/50 bg-yellow-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-500" />
                  Issues Detected
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-1">
                  {health.issues.map((issue, i) => (
                    <li key={i} className="text-muted-foreground">• {issue}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Quick Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
              <CardDescription>Emergency controls for disaster recovery</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={handleReplenish}
                  disabled={isAnyMutating}
                >
                  {replenishMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Replenish Pool
                </Button>

                <Button
                  variant="outline"
                  onClick={handleCleanup}
                  disabled={isAnyMutating}
                >
                  {cleanupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Cleanup Stale
                </Button>

                <Button
                  variant="outline"
                  onClick={handleRestart}
                  disabled={isAnyMutating}
                >
                  {restartMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Restart Service
                </Button>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t">
                <span className="text-sm text-muted-foreground">Force create:</span>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={createCount}
                  onChange={(e) => setCreateCount(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="w-20"
                />
                <Button
                  onClick={handleForceCreate}
                  disabled={isAnyMutating}
                >
                  {forceCreateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Create {createCount} Sandbox{createCount > 1 ? "es" : ""}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Pool Size</CardDescription>
                <CardTitle className="text-3xl">{isLoading ? "..." : stats?.pool_size ?? 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Min: {stats?.config?.min_size ?? "-"} / Max: {stats?.config?.max_size ?? "-"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Created</CardDescription>
                <CardTitle className="text-3xl">{isLoading ? "..." : stats?.total_created ?? 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Since service start
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Claimed</CardDescription>
                <CardTitle className="text-3xl">{isLoading ? "..." : stats?.total_claimed ?? 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Hit rate: {stats?.pool_hit_rate?.toFixed(1) ?? 0}%
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Avg Claim Time</CardDescription>
                <CardTitle className="text-3xl">{isLoading ? "..." : `${stats?.avg_claim_time_ms?.toFixed(0) ?? 0}ms`}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Expired: {stats?.total_expired ?? 0}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Configuration */}
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>Current pool service settings (from environment)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Enabled:</span>
                  <span className="ml-2 font-medium">{stats?.config?.enabled ? "Yes" : "No"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Check Interval:</span>
                  <span className="ml-2 font-medium">{stats?.config?.check_interval ?? "-"}s</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Max Age:</span>
                  <span className="ml-2 font-medium">{stats?.config?.max_age ? `${Math.round(stats.config.max_age / 60)}min` : "-"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Replenish Threshold:</span>
                  <span className="ml-2 font-medium">{stats?.config?.replenish_threshold ? `${(stats.config.replenish_threshold * 100).toFixed(0)}%` : "-"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Replenish:</span>
                  <span className="ml-2 font-medium">{stats?.last_replenish_at ? new Date(stats.last_replenish_at).toLocaleTimeString() : "Never"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Cleanup:</span>
                  <span className="ml-2 font-medium">{stats?.last_cleanup_at ? new Date(stats.last_cleanup_at).toLocaleTimeString() : "Never"}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Pooled Sandboxes List */}
          <Card>
            <CardHeader>
              <CardTitle>Pooled Sandboxes ({sandboxes?.count ?? 0})</CardTitle>
              <CardDescription>Currently available sandboxes in the pool</CardDescription>
            </CardHeader>
            <CardContent>
              {sandboxesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : sandboxes?.sandboxes && sandboxes.sandboxes.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {sandboxes.sandboxes.map((sandbox) => (
                    <div key={sandbox.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 text-sm">
                      <code className="text-xs">{sandbox.external_id}</code>
                      <span className="text-xs text-muted-foreground">
                        {sandbox.pooled_at ? `Pooled ${new Date(sandbox.pooled_at).toLocaleTimeString()}` : "Unknown"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No sandboxes in pool
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
