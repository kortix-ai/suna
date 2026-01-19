"use client";

import { useState } from "react";
import { Search, Loader2, Server, Clock, User, Database, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useStatelessRunLookup } from "@/hooks/admin/use-stateless";

export function RunLookup() {
  const [inputValue, setInputValue] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  
  const { data: runInfo, isLoading, isError, error } = useStatelessRunLookup(searchId);

  const handleSearch = () => {
    if (inputValue.trim().length >= 8) {
      setSearchId(inputValue.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "-";
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const formatTime = (timestamp: number | null) => {
    if (!timestamp) return "-";
    return new Date(timestamp * 1000).toLocaleString();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="w-5 h-5 text-primary" />
          Run Lookup
        </CardTitle>
        <CardDescription>Search for a specific run by ID</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Enter run ID..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="font-mono text-sm"
          />
          <Button 
            onClick={handleSearch} 
            disabled={inputValue.trim().length < 8 || isLoading}
            size="sm"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </Button>
        </div>

        {isError && (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5 text-red-500">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">Run not found or error occurred</span>
          </div>
        )}

        {runInfo && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                {runInfo.run_id}
              </code>
              <Badge variant="outline">
                {runInfo.status || "unknown"}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-2.5 rounded-lg border">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <User className="w-3 h-3" />
                  Owner
                </div>
                <p className="text-sm font-mono truncate">
                  {runInfo.owner || "None"}
                </p>
              </div>
              <div className="p-2.5 rounded-lg border">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Clock className="w-3 h-3" />
                  Duration
                </div>
                <p className="text-sm font-mono">
                  {formatDuration(runInfo.duration)}
                </p>
              </div>
              <div className="p-2.5 rounded-lg border">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Database className="w-3 h-3" />
                  Pending Writes
                </div>
                <p className={cn(
                  "text-sm font-mono",
                  runInfo.pending_writes > 0 && "text-amber-500"
                )}>
                  {runInfo.pending_writes}
                </p>
              </div>
              <div className="p-2.5 rounded-lg border">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Server className="w-3 h-3" />
                  WAL Entries
                </div>
                <p className="text-sm font-mono">
                  {runInfo.wal_entries}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted-foreground">Started:</span>
                <span className="ml-1">{formatTime(runInfo.start)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Last Heartbeat:</span>
                <span className="ml-1">{formatTime(runInfo.heartbeat)}</span>
              </div>
            </div>
          </div>
        )}

        {!runInfo && !isError && !isLoading && searchId && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No results
          </p>
        )}
      </CardContent>
    </Card>
  );
}
