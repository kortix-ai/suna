"use client";

import { Shield, RotateCcw, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CircuitBreaker } from "@/hooks/admin/use-stateless";

interface CircuitBreakersPanelProps {
  breakers: Record<string, CircuitBreaker>;
  onReset: () => void;
  isResetting: boolean;
}

export function CircuitBreakersPanel({
  breakers,
  onReset,
  isResetting,
}: CircuitBreakersPanelProps) {
  const getStateBadge = (state: string) => {
    const colors: Record<string, string> = {
      closed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
      open: "bg-red-500/10 text-red-400 border-red-500/30",
      half_open: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    };
    return (
      <Badge className={colors[state] || "bg-muted"}>
        {state.replace(/_/g, " ")}
      </Badge>
    );
  };

  const breakerList = Object.entries(breakers);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-purple-500" />
              Circuit Breakers
            </CardTitle>
            <CardDescription>
              Protection against cascading failures
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onReset}
            disabled={isResetting}
          >
            {isResetting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <RotateCcw className="w-4 h-4 mr-2" />
            )}
            Reset All
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {breakerList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No circuit breakers registered
          </p>
        ) : (
          <div className="space-y-3">
            {breakerList.map(([name, breaker]) => (
              <div
                key={name}
                className="p-4 rounded-xl border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="font-medium">{name}</span>
                  {getStateBadge(breaker.state)}
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Total Calls</p>
                    <p className="font-mono">{breaker.stats.total_calls}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Success</p>
                    <p className="font-mono text-emerald-500">
                      {breaker.stats.successful_calls}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Failed</p>
                    <p className="font-mono text-red-500">
                      {breaker.stats.failed_calls}
                    </p>
                  </div>
                </div>
                {breaker.state === "open" && breaker.retry_after !== null && (
                  <div className="mt-3 pt-3 border-t">
                    <p className="text-sm text-amber-400">
                      Retry in {breaker.retry_after.toFixed(1)}s
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
