'use client';

/**
 * Provider log tail for a single app deployment. Polled every 6s while
 * open (via useProjectAppLogs).
 */

import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { IconLoader, IconRefresh } from '@/components/ui/kortix-icons';
import { useProjectAppLogs } from '@/hooks/projects/use-project-apps';

interface AppLogsProps {
  projectId: string;
  slug: string;
  onClose: () => void;
}

interface LogEntry {
  ts?: string;
  level?: string;
  message?: string;
}

function parseLogs(data: unknown): LogEntry[] {
  if (Array.isArray(data)) return data as LogEntry[];
  if (data && typeof data === 'object') {
    const maybe = (data as { logs?: unknown; lines?: unknown });
    if (Array.isArray(maybe.logs)) return maybe.logs as LogEntry[];
    if (Array.isArray(maybe.lines)) return maybe.lines as LogEntry[];
  }
  return [];
}

export function AppLogs({ projectId, slug, onClose }: AppLogsProps) {
  const query = useProjectAppLogs(projectId, slug);

  const entries = useMemo(() => {
    if (!query.data?.ok) return [];
    return parseLogs(query.data.data);
  }, [query.data]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-foreground">Logs · {slug}</h3>
          {query.isFetching && (
            <IconLoader className="size-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            aria-label="Refresh logs"
          >
            <IconRefresh className="size-3.5" />
            Refresh
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Back
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/20 px-5 py-4 font-mono text-xs">
        {query.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : query.data && !query.data.ok ? (
          <p className="text-destructive">{query.data.error ?? 'Logs unavailable.'}</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground">
            No log lines yet. Hang on, or trigger a fresh deploy.
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {entries.map((entry, idx) => (
              <li key={idx} className="flex gap-3 whitespace-pre-wrap break-all">
                {entry.ts && (
                  <span className="shrink-0 text-muted-foreground/60">{entry.ts}</span>
                )}
                {entry.level && (
                  <span className="shrink-0 uppercase text-muted-foreground/70">
                    {entry.level}
                  </span>
                )}
                <span className="text-foreground">{entry.message ?? JSON.stringify(entry)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
