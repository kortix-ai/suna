"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Activity,
  Server,
  Database,
  Zap,
  Shield,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { StatelessHealth, Backpressure } from "@/hooks/admin/use-stateless";

interface SystemHealthProps {
  health: StatelessHealth | undefined;
  backpressure: Backpressure | undefined;
  isLoading?: boolean;
}

type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

interface StatusIndicatorProps {
  status: HealthStatus;
  label: string;
  size?: "sm" | "md" | "lg";
}

function StatusIndicator({ status, label, size = "md" }: StatusIndicatorProps) {
  const config = {
    healthy: {
      icon: CheckCircle,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      pulse: "bg-emerald-500",
    },
    degraded: {
      icon: AlertTriangle,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      pulse: "bg-amber-500",
    },
    unhealthy: {
      icon: XCircle,
      color: "text-red-500",
      bg: "bg-red-500/10",
      pulse: "bg-red-500",
    },
    unknown: {
      icon: Activity,
      color: "text-muted-foreground",
      bg: "bg-muted",
      pulse: "bg-muted-foreground",
    },
  };

  const c = config[status];
  const Icon = c.icon;

  const sizeClasses = {
    sm: { wrapper: "gap-1.5", icon: "w-3.5 h-3.5", text: "text-xs", pulse: "w-1.5 h-1.5" },
    md: { wrapper: "gap-2", icon: "w-4 h-4", text: "text-sm", pulse: "w-2 h-2" },
    lg: { wrapper: "gap-2.5", icon: "w-5 h-5", text: "text-base", pulse: "w-2.5 h-2.5" },
  };

  const s = sizeClasses[size];

  return (
    <div className={cn("flex items-center", s.wrapper)}>
      <div className="relative">
        <Icon className={cn(s.icon, c.color)} />
        {status !== "unknown" && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 rounded-full animate-pulse",
              s.pulse,
              c.pulse
            )}
          />
        )}
      </div>
      <span className={cn(s.text, c.color, "font-medium")}>{label}</span>
    </div>
  );
}

interface ServiceStatusProps {
  name: string;
  running: boolean;
  icon: ReactNode;
  details?: string;
}

function ServiceStatus({ name, running, icon, details }: ServiceStatusProps) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg border transition-all">
      <div className="flex items-center gap-3">
        <div className={cn("p-2", running ? "text-emerald-500" : "text-red-500")}>
          {icon}
        </div>
        <div>
          <p className="font-medium text-sm">{name}</p>
          {details && <p className="text-xs text-muted-foreground">{details}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            running ? "bg-emerald-500 animate-pulse" : "bg-red-500"
          )}
        />
        <span className={cn("text-sm", running ? "text-emerald-500" : "text-red-500")}>
          {running ? "Running" : "Stopped"}
        </span>
      </div>
    </div>
  );
}

export function SystemHealthPanel({ health, backpressure, isLoading }: SystemHealthProps) {
  const getOverallStatus = (): HealthStatus => {
    if (!health) return "unknown";
    if (!health.healthy) return "unhealthy";
    if (backpressure?.level === "critical" || backpressure?.level === "high") return "degraded";
    return "healthy";
  };

  const getBackpressureStatus = (): HealthStatus => {
    if (!backpressure) return "unknown";
    switch (backpressure.level) {
      case "normal":
        return "healthy";
      case "elevated":
        return "degraded";
      case "high":
      case "critical":
        return "unhealthy";
      default:
        return "unknown";
    }
  };

  const overallStatus = getOverallStatus();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            System Health
          </CardTitle>
          <StatusIndicator status={overallStatus} label={overallStatus.charAt(0).toUpperCase() + overallStatus.slice(1)} size="md" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Services Grid */}
        <div className="grid gap-3">
          <ServiceStatus
            name="Flusher"
            running={health?.flusher?.running ?? false}
            icon={<Database className="w-4 h-4" />}
            details={`${health?.flusher?.runs ?? 0} runs, ${health?.flusher?.pending ?? 0} pending`}
          />
          <ServiceStatus
            name="Recovery Service"
            running={health?.recovery?.running ?? false}
            icon={<RefreshCw className="w-4 h-4" />}
            details={health?.recovery?.sharded ? `Shard ${health.recovery.shard_id}/${health.recovery.total_shards}` : "Not sharded"}
          />
          <ServiceStatus
            name="Ownership Tracker"
            running={health?.ownership?.running ?? false}
            icon={<Server className="w-4 h-4" />}
            details={`Owning ${health?.ownership?.owned ?? 0} runs`}
          />
        </div>

        {/* Backpressure */}
        {backpressure && (
          <div className="pt-3 border-t">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Backpressure</span>
              <StatusIndicator status={getBackpressureStatus()} label={backpressure.level} size="sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-2.5 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Memory</p>
                <p className="text-sm font-medium">{backpressure.memory_percent.toFixed(1)}%</p>
              </div>
              <div className="p-2.5 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Flush Latency</p>
                <p className="text-sm font-medium">{backpressure.flush_latency_ms.toFixed(0)}ms</p>
              </div>
              <div className="p-2.5 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Accept Work</p>
                <p className={cn("text-sm font-medium", backpressure.should_accept_work ? "text-emerald-500" : "text-red-500")}>
                  {backpressure.should_accept_work ? "Yes" : "No"}
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Shed Load</p>
                <p className={cn("text-sm font-medium", backpressure.should_shed_load ? "text-red-500" : "text-emerald-500")}>
                  {backpressure.should_shed_load ? "Yes" : "No"}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Worker Info */}
        {health?.ownership?.worker_id && (
          <div className="pt-3 border-t">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Worker ID</span>
              <code className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
                {health.ownership.worker_id}
              </code>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Compact header badges
interface HealthBadgesProps {
  health: StatelessHealth | undefined;
  backpressure: Backpressure | undefined;
  alertCount?: number;
}

export function HealthBadges({ health, backpressure, alertCount = 0 }: HealthBadgesProps) {
  const getHealthBadge = () => {
    if (!health) {
      return (
        <Badge variant="outline" className="gap-1.5 px-3 py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
        </Badge>
      );
    }
    if (!health.healthy) {
      return (
        <Badge variant="outline" className="gap-1.5 px-3 py-1">
          <XCircle className="w-3.5 h-3.5 text-red-500" /> Unhealthy
        </Badge>
      );
    }
    if (alertCount > 0) {
      return (
        <Badge variant="outline" className="gap-1.5 px-3 py-1">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> {alertCount} Alert{alertCount > 1 ? "s" : ""}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1.5 px-3 py-1">
        <CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> Healthy
      </Badge>
    );
  };

  const getBackpressureBadge = () => {
    if (!backpressure) return null;
    const config: Record<string, { color: string; icon: typeof Shield }> = {
      normal: { color: "text-emerald-500", icon: Shield },
      elevated: { color: "text-amber-500", icon: AlertTriangle },
      high: { color: "text-orange-500", icon: AlertTriangle },
      critical: { color: "text-red-500", icon: XCircle },
    };
    const c = config[backpressure.level] || config.normal;
    const Icon = c.icon;
    return (
      <Badge variant="outline" className="gap-1.5 px-3 py-1">
        <Icon className={cn("w-3.5 h-3.5", c.color)} />
        {backpressure.level.charAt(0).toUpperCase() + backpressure.level.slice(1)}
      </Badge>
    );
  };

  return (
    <div className="flex items-center gap-2">
      {getBackpressureBadge()}
      {getHealthBadge()}
    </div>
  );
}
