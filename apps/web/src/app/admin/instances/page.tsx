'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminSandboxes, useDeleteAdminSandbox } from '@/hooks/admin/use-admin-sandboxes';
import type { AdminSandbox } from '@/hooks/admin/use-admin-sandboxes';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { toast } from '@/lib/toast';
import {
  Server,
  ShieldCheck,
  Trash2,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  switch (status.toLowerCase()) {
    case 'active':
    case 'running':
      return <Badge variant="highlight">{status}</Badge>;
    case 'pooled':
      return <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 gap-1">{status}</Badge>;
    case 'provisioning':
      return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1">{status}</Badge>;
    case 'stopped':
    case 'paused':
    case 'archived':
      return <Badge variant="secondary">{status}</Badge>;
    case 'error':
    case 'failed':
      return <Badge variant="destructive">{status}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '\u2014';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function AdminInstancesPage() {
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();

  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(searchInput, 350);

  useEffect(() => { setPage(1); }, [search, statusFilter, providerFilter]);

  const { data, isLoading, isFetching, refetch } = useAdminSandboxes({
    search, status: statusFilter, provider: providerFilter, page, limit: PAGE_SIZE,
  });

  const deleteMutation = useDeleteAdminSandbox();
  const [confirmDelete, setConfirmDelete] = useState<AdminSandbox | null>(null);

  const list = data?.sandboxes ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deleteMutation.mutateAsync(confirmDelete.sandboxId);
      toast.success(`Deleted instance ${confirmDelete.sandboxId.slice(0, 8)}`, {
        description: confirmDelete.provider === 'justavps'
          ? 'Removed from DB and JustaVPS machine deleted.'
          : 'Removed from DB.',
      });
    } catch (err: any) {
      toast.error('Failed to delete instance', { description: err.message });
    }
    setConfirmDelete(null);
  }, [confirmDelete, deleteMutation]);

  if (roleLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto p-6">
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-72 mb-8" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!adminRole?.isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <ShieldCheck className="h-12 w-12 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium text-foreground/80">Admin access required</h2>
          <p className="text-sm text-muted-foreground">You don&apos;t have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Server className="h-6 w-6" />
            Admin Instances
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            All instances across every account · {total.toLocaleString()} total
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              className="pl-8 h-8 text-sm"
              placeholder="Search by instance ID, name, account, email..."
              autoComplete="off"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pooled">Pooled</SelectItem>
              <SelectItem value="provisioning">Provisioning</SelectItem>
              <SelectItem value="stopped">Stopped</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={providerFilter || 'all'} onValueChange={(v) => setProviderFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue placeholder="Provider" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              <SelectItem value="justavps">JustAVPS</SelectItem>
              <SelectItem value="daytona">Daytona</SelectItem>
              <SelectItem value="local_docker">Local</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="h-8 gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching ? 'animate-spin' : '')} />
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : list.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border border-foreground/[0.08] rounded-xl">
            <Server className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No instances match your filters</p>
          </div>
        ) : (
          <div className={cn('border border-foreground/[0.08] rounded-xl overflow-hidden transition-opacity', isFetching ? 'opacity-60' : '')}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[90px]">ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Account / Email</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[150px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((sandbox) => (
                  <TableRow
                    key={sandbox.sandboxId}
                    className="group cursor-pointer"
                    onClick={() => router.push(`/admin/instances/${sandbox.sandboxId}`)}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground" title={sandbox.sandboxId}>{sandbox.sandboxId.slice(0, 8)}</TableCell>
                    <TableCell className="text-sm max-w-[140px] truncate" title={sandbox.name ?? undefined}>{sandbox.name ?? <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{sandbox.accountName ?? '\u2014'}</span>
                        {sandbox.ownerEmail && <span className="text-xs text-muted-foreground truncate">{sandbox.ownerEmail}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">{sandbox.provider ?? <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell><StatusBadge status={sandbox.status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(sandbox.createdAt)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2"
                          onClick={() => router.push(`/instances/${sandbox.sandboxId}`)}
                        >
                          Connect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-500 hover:bg-red-500/10"
                          onClick={() => setConfirmDelete(sandbox)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Page {page} of {pages} &mdash; {total.toLocaleString()} results</span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setPage(1)} disabled={page === 1} title="First page">&laquo;</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 gap-1" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 gap-1" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
              <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setPage(pages)} disabled={page === pages} title="Last page">&raquo;</Button>
            </div>
          </div>
        )}

        <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Instance</DialogTitle>
              <DialogDescription>
                Permanently delete <span className="font-mono text-foreground">{confirmDelete?.sandboxId.slice(0, 8)}</span>
                {confirmDelete?.provider === 'justavps' && ' and terminate the JustaVPS machine'}. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {confirmDelete && (
              <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-lg px-4 py-3 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>{confirmDelete.accountName ?? '\u2014'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Provider</span><span className="capitalize">{confirmDelete.provider ?? '\u2014'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{confirmDelete.status ?? '\u2014'}</span></div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleteMutation.isPending}>Cancel</Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
