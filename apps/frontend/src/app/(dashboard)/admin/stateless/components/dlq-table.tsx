"use client";

import { useState, useMemo } from "react";
import {
  Loader2,
  RotateCcw,
  Trash2,
  FileWarning,
  CheckCircle,
  Search,
  Filter,
  ChevronDown,
  Eye,
  Copy,
  ExternalLink,
  AlertCircle,
  X,
  RefreshCw,
  Clock,
  CheckSquare,
  Square,
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
import type { DLQEntry } from "@/hooks/admin/use-stateless";

interface DLQTableProps {
  entries: DLQEntry[];
  isLoading: boolean;
  onRetry: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  isRetrying: boolean;
  isDeleting: boolean;
  onBulkRetry?: (entryIds: string[]) => void;
  onBulkDelete?: (entryIds: string[]) => void;
}

type WriteType = "message" | "credit" | "status" | string;

const writeTypeConfig: Record<WriteType, { label: string; color: string; bgColor: string }> = {
  message: { label: "Message", color: "text-blue-400", bgColor: "bg-blue-500/10 border-blue-500/30" },
  credit: { label: "Credit", color: "text-emerald-400", bgColor: "bg-emerald-500/10 border-emerald-500/30" },
  status: { label: "Status", color: "text-purple-400", bgColor: "bg-purple-500/10 border-purple-500/30" },
};

export function DLQTable({
  entries,
  isLoading,
  onRetry,
  onDelete,
  isRetrying,
  isDeleting,
  onBulkRetry,
  onBulkDelete,
}: DLQTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [detailEntry, setDetailEntry] = useState<DLQEntry | null>(null);
  const [sortBy, setSortBy] = useState<"failed_at" | "attempts">("failed_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Get unique types from entries
  const availableTypes = useMemo(() => {
    const types = new Set(entries.map((e) => e.write_type));
    return Array.from(types);
  }, [entries]);

  // Filter and sort entries
  const filteredEntries = useMemo(() => {
    let result = entries;

    // Filter by search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.entry_id.toLowerCase().includes(query) ||
          e.run_id.toLowerCase().includes(query) ||
          e.error.toLowerCase().includes(query)
      );
    }

    // Filter by type
    if (selectedTypes.size > 0) {
      result = result.filter((e) => selectedTypes.has(e.write_type));
    }

    // Sort
    result = [...result].sort((a, b) => {
      const aVal = sortBy === "failed_at" ? a.failed_at : a.attempt_count;
      const bVal = sortBy === "failed_at" ? b.failed_at : b.attempt_count;
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    return result;
  }, [entries, searchQuery, selectedTypes, sortBy, sortOrder]);

  // Group entries by run_id for summary
  const entriesByRun = useMemo(() => {
    const grouped = new Map<string, DLQEntry[]>();
    entries.forEach((e) => {
      const existing = grouped.get(e.run_id) || [];
      existing.push(e);
      grouped.set(e.run_id, existing);
    });
    return grouped;
  }, [entries]);

  // Group by error type for summary
  const errorSummary = useMemo(() => {
    const errors = new Map<string, number>();
    entries.forEach((e) => {
      const errorType = extractErrorType(e.error);
      errors.set(errorType, (errors.get(errorType) || 0) + 1);
    });
    return Array.from(errors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [entries]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatAge = (timestamp: number) => {
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const getTypeBadge = (type: string) => {
    const config = writeTypeConfig[type] || { label: type, color: "text-muted-foreground", bgColor: "bg-muted" };
    return (
      <Badge className={cn("font-medium", config.bgColor)}>
        {config.label}
      </Badge>
    );
  };

  const toggleSelectAll = () => {
    if (selectedEntries.size === filteredEntries.length) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(filteredEntries.map((e) => e.entry_id)));
    }
  };

  const toggleSelectEntry = (entryId: string) => {
    const newSelected = new Set(selectedEntries);
    if (newSelected.has(entryId)) {
      newSelected.delete(entryId);
    } else {
      newSelected.add(entryId);
    }
    setSelectedEntries(newSelected);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const handleBulkRetry = () => {
    if (onBulkRetry && selectedEntries.size > 0) {
      onBulkRetry(Array.from(selectedEntries));
      setSelectedEntries(new Set());
    }
  };

  const handleBulkDelete = () => {
    if (onBulkDelete && selectedEntries.size > 0) {
      onBulkDelete(Array.from(selectedEntries));
      setSelectedEntries(new Set());
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileWarning className="w-5 h-5 text-red-500" />
                Dead Letter Queue
              </CardTitle>
              <CardDescription className="mt-1">
                Failed writes that exceeded retry limits • {entries.length} total entries
              </CardDescription>
            </div>

            {/* Error Summary Badges */}
            {errorSummary.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {errorSummary.map(([error, count]) => (
                  <Badge
                    key={error}
                    variant="outline"
                    className="text-xs cursor-pointer hover:bg-muted"
                    onClick={() => setSearchQuery(error)}
                  >
                    {error}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Filters and Search */}
          <div className="flex items-center gap-3 mt-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by ID, run ID, or error..."
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
                  Type
                  {selectedTypes.size > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedTypes.size}
                    </Badge>
                  )}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableTypes.map((type) => (
                  <DropdownMenuCheckboxItem
                    key={type}
                    checked={selectedTypes.has(type)}
                    onCheckedChange={(checked) => {
                      const newTypes = new Set(selectedTypes);
                      if (checked) {
                        newTypes.add(type);
                      } else {
                        newTypes.delete(type);
                      }
                      setSelectedTypes(newTypes);
                    }}
                  >
                    {writeTypeConfig[type]?.label || type}
                  </DropdownMenuCheckboxItem>
                ))}
                {selectedTypes.size > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setSelectedTypes(new Set())}>
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
                <DropdownMenuItem onClick={() => { setSortBy("failed_at"); setSortOrder("desc"); }}>
                  Newest first
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSortBy("failed_at"); setSortOrder("asc"); }}>
                  Oldest first
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setSortBy("attempts"); setSortOrder("desc"); }}>
                  Most attempts
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Bulk Actions */}
            {selectedEntries.size > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm text-muted-foreground">
                  {selectedEntries.size} selected
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBulkRetry}
                  disabled={isRetrying}
                  className="h-9"
                >
                  <RefreshCw className="w-4 h-4 mr-1.5" />
                  Retry All
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBulkDelete}
                  disabled={isDeleting}
                  className="h-9 text-red-500 hover:text-red-600"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  Delete All
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
          ) : filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-500/50 mb-3" />
              <p className="text-muted-foreground font-medium">
                {entries.length === 0 ? "No entries in DLQ" : "No entries match filters"}
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                {entries.length === 0
                  ? "All writes have been processed successfully"
                  : "Try adjusting your search or filters"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y bg-muted/50">
                    <th className="h-11 px-4 text-left">
                      <button
                        onClick={toggleSelectAll}
                        className="flex items-center justify-center"
                      >
                        {selectedEntries.size === filteredEntries.length ? (
                          <CheckSquare className="w-4 h-4 text-primary" />
                        ) : (
                          <Square className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Entry / Run
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Type
                    </th>
                    <th className="h-11 px-4 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Attempts
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Failed
                    </th>
                    <th className="h-11 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Error
                    </th>
                    <th className="h-11 px-4 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry) => (
                    <tr
                      key={entry.entry_id}
                      className={cn(
                        "border-b transition-colors hover:bg-muted/30",
                        selectedEntries.has(entry.entry_id) && "bg-primary/5"
                      )}
                    >
                      <td className="h-14 px-4">
                        <button
                          onClick={() => toggleSelectEntry(entry.entry_id)}
                          className="flex items-center justify-center"
                        >
                          {selectedEntries.has(entry.entry_id) ? (
                            <CheckSquare className="w-4 h-4 text-primary" />
                          ) : (
                            <Square className="w-4 h-4 text-muted-foreground" />
                          )}
                        </button>
                      </td>
                      <td className="h-14 px-4">
                        <div className="space-y-0.5">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => copyToClipboard(entry.entry_id)}
                                  className="font-mono text-sm hover:text-primary transition-colors"
                                >
                                  {entry.entry_id.slice(0, 8)}...
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">{entry.entry_id}</p>
                                <p className="text-xs text-muted-foreground mt-1">Click to copy</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => copyToClipboard(entry.run_id)}
                                  className="font-mono text-xs text-muted-foreground hover:text-primary transition-colors"
                                >
                                  Run: {entry.run_id.slice(0, 8)}...
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">{entry.run_id}</p>
                                <p className="text-xs text-muted-foreground mt-1">Click to copy</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </td>
                      <td className="h-14 px-4">{getTypeBadge(entry.write_type)}</td>
                      <td className="h-14 px-4 text-center">
                        <Badge
                          variant="outline"
                          className={cn(
                            entry.attempt_count >= 3 && "border-red-500/30 text-red-400"
                          )}
                        >
                          {entry.attempt_count}
                        </Badge>
                      </td>
                      <td className="h-14 px-4">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger>
                              <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5" />
                                {formatAge(entry.failed_at)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="text-xs">{formatTime(entry.failed_at)}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>
                      <td className="h-14 px-4 max-w-[250px]">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => setDetailEntry(entry)}
                                className="text-sm text-red-400 truncate block max-w-full text-left hover:text-red-300 transition-colors"
                              >
                                {extractErrorType(entry.error)}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              <p className="text-xs font-mono whitespace-pre-wrap break-all">
                                {entry.error.slice(0, 300)}
                                {entry.error.length > 300 && "..."}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Click to view full error
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
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
                                  onClick={() => setDetailEntry(entry)}
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
                                  className="h-8 w-8"
                                  onClick={() => onRetry(entry.entry_id)}
                                  disabled={isRetrying || isDeleting}
                                >
                                  {isRetrying ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-4 h-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Retry</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-500 hover:text-red-600"
                                  onClick={() => onDelete(entry.entry_id)}
                                  disabled={isRetrying || isDeleting}
                                >
                                  {isDeleting ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-4 h-4" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete</TooltipContent>
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
      <Dialog open={!!detailEntry} onOpenChange={() => setDetailEntry(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" />
              DLQ Entry Details
            </DialogTitle>
            <DialogDescription>
              Complete information about this failed write
            </DialogDescription>
          </DialogHeader>

          {detailEntry && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Entry ID
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded flex-1 truncate">
                      {detailEntry.entry_id}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => copyToClipboard(detailEntry.entry_id)}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Run ID
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded flex-1 truncate">
                      {detailEntry.run_id}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => copyToClipboard(detailEntry.run_id)}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Type
                  </label>
                  <div>{getTypeBadge(detailEntry.write_type)}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Attempts
                  </label>
                  <Badge variant="outline" className="border-red-500/30 text-red-400">
                    {detailEntry.attempt_count}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Failed At
                  </label>
                  <p className="text-sm">{formatTime(detailEntry.failed_at)}</p>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Created At
                </label>
                <p className="text-sm">{formatTime(detailEntry.created_at)}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Error Message
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => copyToClipboard(detailEntry.error)}
                  >
                    <Copy className="w-3.5 h-3.5 mr-1.5" />
                    Copy
                  </Button>
                </div>
                <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 max-h-[200px] overflow-y-auto">
                  <pre className="text-sm font-mono text-red-400 whitespace-pre-wrap break-all">
                    {detailEntry.error}
                  </pre>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t">
                <Button
                  onClick={() => {
                    onRetry(detailEntry.entry_id);
                    setDetailEntry(null);
                  }}
                  disabled={isRetrying}
                >
                  {isRetrying ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RotateCcw className="w-4 h-4 mr-2" />
                  )}
                  Retry Entry
                </Button>
                <Button
                  variant="outline"
                  className="text-red-500 hover:text-red-600"
                  onClick={() => {
                    onDelete(detailEntry.entry_id);
                    setDetailEntry(null);
                  }}
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-2" />
                  )}
                  Delete Entry
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function extractErrorType(error: string): string {
  const match = error.match(/([a-zA-Z]+\.errors\.[a-zA-Z]+)/);
  if (match) return match[1].split(".").pop() || error.slice(0, 30);
  const pyMatch = error.match(/^([A-Z][a-zA-Z]+Error|[A-Z][a-zA-Z]+Exception)/);
  if (pyMatch) return pyMatch[1];
  return error.slice(0, 30) + (error.length > 30 ? "..." : "");
}
