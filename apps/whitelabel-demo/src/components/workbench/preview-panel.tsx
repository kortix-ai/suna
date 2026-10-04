'use client';

import Loading from '@/components/ui/loading';

/**
 * The live-preview surface for a session.
 *
 * Session data uses the shared SDK client. The same-origin preview BFF resolves
 * readiness, the final URL, and scoped authentication on the server. The
 * sharing controls and the public-shares list live beside it in
 * `session-sharing.tsx`.
 */

import { useWrapperMode } from '@/app/providers';
import { SessionSharing, PublicSharesList } from '@/components/workbench/session-sharing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getApiKey, kortix } from '@/lib/kortix';
import { authHeaders, getSessionToken } from '@/lib/session';
import { qk } from '@/lib/query-keys';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  Globe,
  Link2,
  MonitorPlay,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

function statusVariant(status?: string) {
  if (status === 'online') return 'default' as const;
  if (status === 'offline') return 'destructive' as const;
  return 'secondary' as const;
}

interface PreviewUrlResponse {
  url: string;
  tokenId: string;
}

async function resolvePreviewUrl({
  wrapperMode,
  projectId,
  sessionId,
  preview,
  targetUrl,
}: {
  wrapperMode: boolean;
  projectId: string;
  sessionId: string;
  preview?: { port: number; path: string };
  targetUrl?: string;
}): Promise<PreviewUrlResponse> {
  const token = wrapperMode ? getSessionToken() : getApiKey();
  const response = await fetch('/api/preview-url', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(token),
    },
    body: JSON.stringify({
      projectId,
      sessionId,
      ...(preview ? { preview } : {}),
      ...(targetUrl ? { targetUrl } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    url?: string;
    tokenId?: string;
    error?: string;
  };
  if (!response.ok || !body.url || !body.tokenId) {
    throw new Error(body.error || 'Could not resolve preview URL');
  }
  return { url: body.url, tokenId: body.tokenId };
}

export function PreviewPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const wrapperMode = useWrapperMode();
  const session = useMemo(() => kortix.session(projectId, sessionId), [projectId, sessionId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // "Open a localhost link" state — paste a URL the agent printed.
  const [localhostUrl, setLocalhostUrl] = useState('');

  const previewsQuery = useQuery({
    queryKey: qk.sessionPreviews(projectId, sessionId),
    queryFn: () => session.previews(),
    refetchInterval: 5000,
  });

  const candidates = previewsQuery.data?.candidates ?? [];

  // Default the selection to the first candidate once they arrive / keep a
  // valid selection if the previously-selected port disappears.
  useEffect(() => {
    if (candidates.length === 0) return;
    if (!selectedId || !candidates.some((c) => c.id === selectedId)) {
      setSelectedId(candidates[0].id);
    }
  }, [candidates, selectedId]);

  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  const previewUrlQuery = useQuery({
    queryKey: [
      'preview-url',
      projectId,
      sessionId,
      selected?.id,
      selected?.port,
      selected?.path,
      reloadNonce,
    ],
    queryFn: () => {
      if (!selected) throw new Error('No preview selected');
      return resolvePreviewUrl({
        wrapperMode,
        projectId,
        sessionId,
        preview: { port: selected.port, path: selected.path || '/' },
      });
    },
    enabled: !!selected,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const previewSrc = previewUrlQuery.data?.url ?? null;

  const openLocalhostMut = useMutation({
    mutationFn: async ({ targetUrl, popup }: { targetUrl: string; popup: Window }) => {
      const resolved = await resolvePreviewUrl({
        wrapperMode,
        projectId,
        sessionId,
        targetUrl,
      });
      return { ...resolved, popup };
    },
    onSuccess: ({ url, popup }) => {
      popup.location.replace(url);
    },
    onError: (error, { popup }) => {
      popup.close();
      toast.error(error instanceof Error ? error.message : 'Could not resolve preview URL');
    },
  });

  function openLocalhost() {
    const targetUrl = localhostUrl.trim();
    if (!targetUrl) return;
    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
    if (!popup) {
      toast.error('Allow pop-ups to open this preview');
      return;
    }
    openLocalhostMut.mutate({ targetUrl, popup });
  }

  const loadingPreviews = previewsQuery.isLoading || (!!selected && previewUrlQuery.isLoading);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <MonitorPlay className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Preview</span>

        {candidates.length > 0 && (
          <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 w-[220px] text-xs">
              <SelectValue placeholder="Select a port" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  <span className="flex items-center gap-2">
                    <Badge variant={statusVariant(c.status)} className="px-1.5 py-0 text-[0.65rem]">
                      :{c.port}
                    </Badge>
                    <span className="truncate">{c.label || c.path || `Port ${c.port}`}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => {
              setReloadNonce((n) => n + 1);
              void previewsQuery.refetch();
            }}
            disabled={previewsQuery.isFetching}
          >
            {previewsQuery.isFetching ? (
              <Loading className="size-3.5" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>

          {previewSrc && (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
              <a href={previewSrc} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" />
                Open in new tab
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* Sharing controls */}
      <SessionSharing projectId={projectId} sessionId={sessionId} selected={selected} />

      {/* Preview surface */}
      <Card className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-border bg-card/50 p-0">
        {loadingPreviews ? (
          <div className="flex h-full flex-col gap-3 p-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="min-h-0 flex-1" />
          </div>
        ) : previewUrlQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Globe className="size-8 text-destructive/60" />
            <p className="text-sm font-medium text-foreground">Preview unavailable</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {previewUrlQuery.error instanceof Error
                ? previewUrlQuery.error.message
                : 'Could not resolve preview URL'}
            </p>
          </div>
        ) : previewSrc ? (
          <iframe
            key={`${selected?.id}-${reloadNonce}`}
            src={previewSrc}
            title={selected?.label || `Preview on port ${selected?.port}`}
            className="h-full min-h-0 w-full flex-1 border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Globe className="size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No preview yet</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              The agent hasn't exposed a port. Once it starts a dev server the preview will
              appear here automatically.
            </p>
          </div>
        )}
      </Card>

      {/* Public shares */}
      <PublicSharesList projectId={projectId} sessionId={sessionId} />

      {/* Open a localhost link — proxy a URL the agent printed */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <Link2 className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Open a localhost link</span>
        </div>
        <Separator />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            openLocalhost();
          }}
        >
          <Input
            value={localhostUrl}
            onChange={(e) => setLocalhostUrl(e.target.value)}
            placeholder="http://localhost:3000/foo"
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5"
            disabled={!localhostUrl.trim() || openLocalhostMut.isPending}
          >
            {openLocalhostMut.isPending ? (
              <Loading className="size-3.5" />
            ) : (
              <ExternalLink className="size-3.5" />
            )}
            Open
          </Button>
        </form>
      </div>
    </div>
  );
}
