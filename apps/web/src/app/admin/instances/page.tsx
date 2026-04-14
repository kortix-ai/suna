'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconInbox } from '@/components/ui/kortix-icons';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { InstanceSettingsModal } from '@/app/instances/_components/instance-settings-modal';
import type { SandboxInfo } from '@/lib/platform-client';
import {
  useAdminSandboxes,
  useDeleteAdminSandbox,
  type AdminSandbox,
} from '@/hooks/admin/use-admin-sandboxes';

import {
  SectionContainer,
  SectionHeader,
  StatPill,
  StatRow,
} from '../_components/section-header';

const PAGE_SIZE = 50;

const STATUSES = ['active', 'pooled', 'provisioning', 'stopped', 'archived', 'error'] as const;
const PROVIDERS = ['justavps', 'daytona', 'local_docker'] as const;

function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function statusVariant(status: string | null): React.ComponentProps<typeof Badge>['variant'] {
  if (!status) return 'secondary';
  switch (status.toLowerCase()) {
    case 'active':
    case 'running':
      return 'success';
    case 'pooled':
      return 'info';
    case 'provisioning':
      return 'warning';
    case 'error':
    case 'failed':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelative(value: string | null) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

function toSandboxInfo(sandbox: AdminSandbox): SandboxInfo {
  return {
    sandbox_id: sandbox.sandboxId,
    external_id: sandbox.externalId || '',
    name: sandbox.name || sandbox.sandboxId,
    provider: (sandbox.provider as SandboxInfo['provider']) || 'justavps',
    base_url: sandbox.baseUrl || '',
    status: sandbox.status || 'unknown',
    metadata: (sandbox.metadata as Record<string, unknown> | undefined) ?? undefined,
    created_at: sandbox.createdAt,
    updated_at: sandbox.updatedAt,
  };
}

export default function AdminInstancesPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(searchInput);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, providerFilter]);

  const { data, isLoading, isFetching, refetch } = useAdminSandboxes({
    search,
    status: statusFilter,
    provider: providerFilter,
    page,
    limit: PAGE_SIZE,
  });

  // Stat pills — three cheap parallel count queries.
  const totalsQuery = useAdminSandboxes({ page: 1, limit: 1 });
  const activeQuery = useAdminSandboxes({ status: 'active', page: 1, limit: 1 });
  const errorQuery = useAdminSandboxes({ status: 'error', page: 1, limit: 1 });
  const pooledQuery = useAdminSandboxes({ status: 'pooled', page: 1, limit: 1 });

  const deleteMutation = useDeleteAdminSandbox();
  const [confirmDelete, setConfirmDelete] = useState<AdminSandbox | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedSandbox, setSelectedSandbox] = useState<SandboxInfo | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const list = data?.sandboxes ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Reset selection when the underlying page changes.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, search, statusFilter, providerFilter]);

  const allSelected = list.length > 0 && selectedIds.size === list.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < list.length;

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(list.map((s) => s.sandboxId)));
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedSandboxes = useMemo(
    () => list.filter((s) => selectedIds.has(s.sandboxId)),
    [list, selectedIds],
  );

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deleteMutation.mutateAsync(confirmDelete.sandboxId);
      toast.success(`Deleted ${confirmDelete.sandboxId.slice(0, 8)}`, {
        description:
          confirmDelete.provider === 'justavps'
            ? 'Removed from DB and JustaVPS machine deleted.'
            : 'Removed from DB.',
      });
    } catch (err: any) {
      toast.error('Failed to delete instance', { description: err.message });
    }
    setConfirmDelete(null);
  }, [confirmDelete, deleteMutation]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => deleteMutation.mutateAsync(id)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = ids.length - ok;
    if (ok > 0) toast.success(`Deleted ${ok} instance${ok === 1 ? '' : 's'}`);
    if (failed > 0) toast.error(`Failed to delete ${failed} instance${failed === 1 ? '' : 's'}`);
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
  }, [selectedIds, deleteMutation]);

  const hasFilters = !!(search || statusFilter || providerFilter);

  return (
    <SectionContainer>
      <SectionHeader
        icon={Server}
        title="Instances"
        description="Every sandbox across every account — inspect lifecycle, open shared settings, and delete from DB and provider in one place."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <StatRow>
        <StatPill label="Total" value={(totalsQuery.data?.total ?? 0).toLocaleString()} />
        <StatPill
          label="Active"
          value={(activeQuery.data?.total ?? 0).toLocaleString()}
          tone="success"
        />
        <StatPill
          label="Pooled"
          value={(pooledQuery.data?.total ?? 0).toLocaleString()}
          tone="info"
        />
        <StatPill
          label="Errored"
          value={(errorQuery.data?.total ?? 0).toLocaleString()}
          tone={(errorQuery.data?.total ?? 0) > 0 ? 'danger' : 'default'}
          hint={(errorQuery.data?.total ?? 0) > 0 ? 'Needs attention' : 'All clear'}
        />
      </StatRow>

      <div className="flex flex-col gap-2 sm:flex-row">
        <PageSearchBar
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by instance ID, name, account, or email…"
        />
        <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-9 w-full sm:w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={providerFilter || 'all'}
          onValueChange={(v) => setProviderFilter(v === 'all' ? '' : v)}
        >
          <SelectTrigger className="h-9 w-full sm:w-[140px]">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 shrink-0"
            onClick={() => {
              setSearchInput('');
              setStatusFilter('');
              setProviderFilter('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 px-4 py-2.5">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => setConfirmBulkDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete selected
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-border/60 bg-card">
          <EmptyState
            icon={IconInbox}
            title={hasFilters ? 'No instances match your filters' : 'No instances yet'}
            description={
              hasFilters
                ? 'Try clearing filters or adjusting your search.'
                : 'Instances will appear here as accounts spin them up.'
            }
            action={
              hasFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchInput('');
                    setStatusFilter('');
                    setProviderFilter('');
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            'rounded-2xl border border-border/60 overflow-hidden transition-opacity',
            isFetching && 'opacity-70',
          )}
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected || (someSelected && 'indeterminate')}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="w-[90px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead className="w-[160px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((sandbox) => {
                const selected = selectedIds.has(sandbox.sandboxId);
                return (
                  <TableRow
                    key={sandbox.sandboxId}
                    data-state={selected ? 'selected' : undefined}
                    className="group cursor-pointer"
                    onClick={() => setSelectedSandbox(toSandboxInfo(sandbox))}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected}
                        onCheckedChange={() => toggleOne(sandbox.sandboxId)}
                        aria-label={`Select ${sandbox.sandboxId}`}
                      />
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-muted-foreground"
                      title={sandbox.sandboxId}
                    >
                      {sandbox.sandboxId.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-sm max-w-[180px] truncate" title={sandbox.name ?? undefined}>
                      {sandbox.name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col min-w-0 max-w-[220px]">
                        <span className="text-sm truncate font-medium">
                          {sandbox.accountName ?? (
                            <span className="text-muted-foreground font-normal">—</span>
                          )}
                        </span>
                        {sandbox.ownerEmail && (
                          <span className="text-xs text-muted-foreground truncate">
                            {sandbox.ownerEmail}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {sandbox.provider ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(sandbox.status)} size="sm" className="capitalize">
                        {sandbox.status ?? 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(sandbox.lastUsedAt || sandbox.updatedAt || sandbox.createdAt)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5"
                          onClick={() => router.push(`/instances/${sandbox.sandboxId}`)}
                        >
                          Connect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          onClick={() => setConfirmDelete(sandbox)}
                          aria-label="Delete instance"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {pages} · {total.toLocaleString()} results
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 gap-1"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 gap-1"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page === pages}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Delete instance?"
        description={
          <div className="space-y-2 text-sm">
            <p>
              Permanently delete{' '}
              <span className="font-mono text-foreground">
                {confirmDelete?.sandboxId.slice(0, 8)}
              </span>
              {confirmDelete?.provider === 'justavps' && ' and terminate the JustaVPS machine'}.
              This cannot be undone.
            </p>
            {confirmDelete && (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Account</span>
                  <span>{confirmDelete.accountName ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="capitalize">{confirmDelete.provider ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span>{confirmDelete.status ?? '—'}</span>
                </div>
              </div>
            )}
          </div>
        }
        confirmLabel="Delete"
        onConfirm={handleDelete}
        isPending={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.size} instance${selectedIds.size === 1 ? '' : 's'}?`}
        description={
          <div className="space-y-2 text-sm">
            <p>
              This will remove {selectedIds.size} instance
              {selectedIds.size === 1 ? '' : 's'} from the DB and attempt to terminate each
              provider machine. This cannot be undone.
            </p>
            {selectedSandboxes.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-border/60 bg-muted/30 px-3 py-2 space-y-1 text-xs font-mono">
                {selectedSandboxes.slice(0, 10).map((s) => (
                  <div key={s.sandboxId} className="truncate">
                    {s.sandboxId.slice(0, 8)} · {s.accountName ?? '—'}
                  </div>
                ))}
                {selectedSandboxes.length > 10 && (
                  <div className="text-muted-foreground">
                    …and {selectedSandboxes.length - 10} more
                  </div>
                )}
              </div>
            )}
          </div>
        }
        confirmLabel="Delete selected"
        onConfirm={handleBulkDelete}
        isPending={deleteMutation.isPending}
      />

      <InstanceSettingsModal
        sandbox={selectedSandbox}
        open={!!selectedSandbox}
        onOpenChange={(open) => {
          if (!open) setSelectedSandbox(null);
        }}
      />
    </SectionContainer>
  );
}
