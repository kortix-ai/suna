"use client";

import { Gauge, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { Backpressure } from "@/hooks/admin/use-stateless";

interface BackpressurePanelProps {
  backpressure: Backpressure | undefined;
}

export function BackpressurePanel({ backpressure }: BackpressurePanelProps) {
  if (!backpressure) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="w-5 h-5 text-blue-500" />
            Backpressure
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            Loading backpressure data...
          </p>
        </CardContent>
      </Card>
    );
  }

  const getLevelColor = (level: string) => {
    const colors: Record<string, string> = {
      normal: "text-emerald-500",
      elevated: "text-amber-500",
      high: "text-orange-500",
      critical: "text-red-500",
    };
    return colors[level] || "text-muted-foreground";
  };

  const getLevelBgColor = (level: string) => {
    const colors: Record<string, string> = {
      normal: "bg-emerald-500",
      elevated: "bg-amber-500",
      high: "bg-orange-500",
      critical: "bg-red-500",
    };
    return colors[level] || "bg-muted";
  };

  const levelProgress: Record<string, number> = {
    normal: 25,
    elevated: 50,
    high: 75,
    critical: 100,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-blue-500" />
          Backpressure
        </CardTitle>
        <CardDescription>
          System load and adaptive controls
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="text-center">
          <p className={`text-4xl font-bold ${getLevelColor(backpressure.level)}`}>
            {backpressure.level.charAt(0).toUpperCase() + backpressure.level.slice(1)}
          </p>
          <Progress
            value={levelProgress[backpressure.level]}
            className={`mt-3 h-2 ${getLevelBgColor(backpressure.level)}`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-xl border">
            <p className="text-xs text-muted-foreground">Pending Writes</p>
            <p className="text-lg font-bold">{backpressure.pending_writes}</p>
          </div>
          <div className="p-3 rounded-xl border">
            <p className="text-xs text-muted-foreground">Active Runs</p>
            <p className="text-lg font-bold">{backpressure.active_runs}</p>
          </div>
          <div className="p-3 rounded-xl border">
            <p className="text-xs text-muted-foreground">Flush Latency</p>
            <p className="text-lg font-bold">{backpressure.flush_latency_ms.toFixed(0)}ms</p>
          </div>
          <div className="p-3 rounded-xl border">
            <p className="text-xs text-muted-foreground">Memory</p>
            <p className="text-lg font-bold">{backpressure.memory_percent.toFixed(1)}%</p>
          </div>
        </div>

        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm">Accept Work</span>
            <Badge
              className={
                backpressure.should_accept_work
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-red-500/10 text-red-400"
              }
            >
              {backpressure.should_accept_work ? "Yes" : "No"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Shed Load</span>
            <Badge
              className={
                backpressure.should_shed_load
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-emerald-500/10 text-emerald-400"
              }
            >
              {backpressure.should_shed_load ? "Yes" : "No"}
            </Badge>
          </div>
        </div>

        <div className="space-y-2 pt-4 border-t">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Recommendations
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Batch Size</span>
            <span className="font-mono">{backpressure.recommended_batch_size}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>Flush Interval</span>
            <span className="font-mono">{backpressure.recommended_flush_interval}s</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
