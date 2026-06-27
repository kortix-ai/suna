'use client';

/**
 * The live-preview + sharing surface for a session. Polls the ports the agent
 * has exposed (`previews()`), renders the selected one in an <iframe> built from
 * the SYNC `previewUrl(port, path)`, lets the operator set the session sharing
 * intent (`setSharing`), and mint/manage public links over the preview
 * (`publicShares.list/create/revoke`). Everything flows through the `@kortix/sdk`
 * session facade — no raw HTTP.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  MonitorPlay,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { kortix } from '@/lib/kortix';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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

// Session sharing intent — a subset of the SDK's ConnectorSharing union that
// needs no extra ids (private requires an ownerId, so it's omitted here).
const SHARING_OPTIONS = [
  { value: 'project', label: 'Everyone in project', intent: { mode: 'project' } as const },
  { value: 'members', label: 'Specific members only', intent: { mode: 'members' } as const },
];

function statusVariant(status?: string) {
  if (status === 'online') return 'default' as const;
  if (status === 'offline') return 'destructive' as const;
  return 'secondary' as const;
}

/** Best-effort copyable URL for a public share, defensively reading its shape. */
function shareUrl(share: any): string {
  const raw: string =
    share?.public_path ?? share?.proxy_path ?? share?.public_token ?? '';
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) return raw;
  if (typeof window !== 'undefined') {
    try {
      return new URL(raw, window.location.origin).toString();
    } catch {
      return raw;
    }
  }
  return raw;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Could not copy');
  }
}

export function PreviewPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const session = useMemo(
    () => kortix.session(projectId, sessionId),
    [projectId, sessionId],
  );

  const previewsKey = ['session-previews', projectId, sessionId];
  const sharesKey = ['session-shares', projectId, sessionId];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [sharingMode, setSharingMode] = useState<string>('project');

  // Create-share dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [shareLabel, setShareLabel] = useState('');
  const [shareInteractive, setShareInteractive] = useState('interactive');

  // "Open a localhost link" state — paste a URL the agent printed.
  const [localhostUrl, setLocalhostUrl] = useState('');

  function openProxied() {
    const raw = localhostUrl.trim();
    if (!raw) return;
    // SYNC — rewrites localhost → the session's runtime proxy, returns a string.
    const url = session.proxyUrl(raw);
    if (!url) {
      toast.error('Could not build a proxy URL for that link');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const previewsQuery = useQuery({
    queryKey: previewsKey,
    queryFn: () => session.previews(),
    refetchInterval: 5000,
  });

  const sharesQuery = useQuery({
    queryKey: sharesKey,
    queryFn: () => session.publicShares.list(),
  });

  const candidates = (previewsQuery.data?.candidates ?? []) as any[];
  const shares = (sharesQuery.data?.shares ?? []) as any[];

  // Default the selection to the first candidate once they arrive / keep a
  // valid selection if the previously-selected port disappears.
  useEffect(() => {
    if (candidates.length === 0) return;
    if (!selectedId || !candidates.some((c) => c.id === selectedId)) {
      setSelectedId(candidates[0].id);
    }
  }, [candidates, selectedId]);

  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  // SYNC — call directly in render, never awaited.
  const previewSrc = selected
    ? session.previewUrl(selected.port, selected.path)
    : null;

  const setSharingMut = useMutation({
    mutationFn: (value: string) => {
      const opt = SHARING_OPTIONS.find((o) => o.value === value) ?? SHARING_OPTIONS[0];
      return session.setSharing(opt.intent);
    },
    onSuccess: (_data, value) => {
      setSharingMode(value);
      qc.invalidateQueries({ queryKey: sharesKey });
      toast.success('Sharing updated');
    },
    onError: (err: any) => toast.error(err?.message ?? 'Failed to update sharing'),
  });

  const createMut = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('No preview selected');
      return session.publicShares.create({
        preview_id: selected.id,
        preview: {
          label: selected.label,
          port: selected.port,
          path: selected.path,
        },
        mode: shareInteractive === 'interactive' ? 'interactive' : 'view',
        label: shareLabel.trim() || selected.label,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sharesKey });
      toast.success('Public share created');
      setCreateOpen(false);
      setShareLabel('');
    },
    onError: (err: any) => toast.error(err?.message ?? 'Failed to create share'),
  });

  const revokeMut = useMutation({
    mutationFn: (shareId: string) => session.publicShares.revoke(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sharesKey });
      toast.success('Share revoked');
    },
    onError: (err: any) => toast.error(err?.message ?? 'Failed to revoke share'),
  });

  const loadingPreviews = previewsQuery.isLoading;

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
            <RefreshCw
              className={cn('size-3.5', previewsQuery.isFetching && 'animate-spin')}
            />
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
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Share2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Session visibility</span>
        <Select
          value={sharingMode}
          onValueChange={(v) => setSharingMut.mutate(v)}
          disabled={setSharingMut.isPending}
        >
          <SelectTrigger className="h-8 w-[200px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHARING_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {setSharingMut.isPending && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto h-8 gap-1.5"
              disabled={!selected}
            >
              <Plus className="size-3.5" />
              Create public share
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create public share</DialogTitle>
              <DialogDescription>
                Mint a public link for{' '}
                <span className="font-mono text-foreground">
                  {selected ? `:${selected.port}${selected.path ?? ''}` : 'the preview'}
                </span>
                .
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Label</label>
                <Input
                  value={shareLabel}
                  onChange={(e) => setShareLabel(e.target.value)}
                  placeholder={selected?.label || 'My preview'}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Mode</label>
                <Select value={shareInteractive} onValueChange={setShareInteractive}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="interactive" className="text-xs">
                      Interactive
                    </SelectItem>
                    <SelectItem value="view" className="text-xs">
                      View only
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateOpen(false)}
                disabled={createMut.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || !selected}
              >
                {createMut.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Share2 className="size-3.5" />
                )}
                Create link
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Preview surface */}
      <Card className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-border bg-card/50 p-0">
        {loadingPreviews ? (
          <div className="flex h-full flex-col gap-3 p-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="min-h-0 flex-1" />
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
              The agent hasn&apos;t exposed a port. Once it starts a dev server the
              preview will appear here automatically.
            </p>
          </div>
        )}
      </Card>

      {/* Public shares */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Public shares</span>
          <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
            {shares.length}
          </Badge>
          {sharesQuery.isFetching && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <Separator />
        {shares.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            No public links yet. Create one to share this preview outside the workspace.
          </p>
        ) : (
          <ul className="max-h-48 space-y-1.5 overflow-auto scrollbar-thin">
            {shares.map((share) => {
              const url = shareUrl(share);
              const revoked = !!share.revoked_at;
              return (
                <li
                  key={share.share_id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {share.label || `Port ${share.port ?? '—'}`}
                      </span>
                      {revoked ? (
                        <Badge variant="destructive" className="px-1.5 py-0 text-[0.65rem]">
                          revoked
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                          {share.mode || 'view'}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
                      {url || '—'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    disabled={!url}
                    onClick={() => copy(url)}
                    title="Copy URL"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-destructive hover:text-destructive"
                    disabled={revoked || revokeMut.isPending}
                    onClick={() => revokeMut.mutate(share.share_id)}
                    title="Revoke share"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
            openProxied();
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
            disabled={!localhostUrl.trim()}
          >
            <ExternalLink className="size-3.5" />
            Open
          </Button>
        </form>
      </div>
    </div>
  );
}
