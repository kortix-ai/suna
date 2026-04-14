"use client";

import { Gauge, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RateLimiterStats } from "@/hooks/admin/use-stateless";

interface RateLimitersPanelProps {
  limiters: Record<string, RateLimiterStats>;
}

export function RateLimitersPanel({ limiters }: RateLimitersPanelProps) {
  const limiterList = Object.entries(limiters);

  const getUsagePercent = (stats: RateLimiterStats): number => {
    if (stats.type === "token_bucket" && stats.capacity && stats.tokens !== undefined) {
      return ((stats.capacity - stats.tokens) / stats.capacity) * 100;
    }
    if (stats.type === "sliding_window" && stats.max_requests && stats.requests_in_window !== undefined) {
      return (stats.requests_in_window / stats.max_requests) * 100;
    }
    return 0;
  };

  const getStatusColor = (percent: number): string => {
    if (percent < 50) return "text-emerald-500";
    if (percent < 80) return "text-amber-500";
    return "text-red-500";
  };

  const getProgressColor = (percent: number): string => {
    if (percent < 50) return "bg-emerald-500";
    if (percent < 80) return "bg-amber-500";
    return "bg-red-500";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="w-5 h-5 text-primary" />
          Rate Limiters
        </CardTitle>
        <CardDescription>Request throttling and traffic control</CardDescription>
      </CardHeader>
      <CardContent>
        {limiterList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No rate limiters registered
          </p>
        ) : (
          <div className="space-y-4">
            {limiterList.map(([name, stats]) => {
              const usagePercent = getUsagePercent(stats);
              return (
                <div key={name} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{name}</span>
                      <Badge variant="outline" className="text-xs">
                        {stats.type.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <span className={cn("text-sm font-mono", getStatusColor(usagePercent))}>
                      {usagePercent.toFixed(0)}%
                    </span>
                  </div>
                  <Progress 
                    value={usagePercent} 
                    className={cn("h-2", getProgressColor(usagePercent))}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {stats.type === "token_bucket" && (
                      <>
                        <span>Tokens: {stats.tokens?.toFixed(0)} / {stats.capacity}</span>
                        <span>Rate: {stats.rate}/s</span>
                      </>
                    )}
                    {stats.type === "sliding_window" && (
                      <>
                        <span>Requests: {stats.requests_in_window} / {stats.max_requests}</span>
                        <span>Window: {stats.window_seconds}s</span>
                      </>
                    )}
                    {stats.type === "adaptive" && (
                      <>
                        <span>Rate: {stats.current_rate?.toFixed(1)}/s</span>
                        <span>Range: {stats.min_rate} - {stats.max_rate}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
