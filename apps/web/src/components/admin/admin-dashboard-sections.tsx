'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  Loader2,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { InstanceSettingsModal } from '@/app/instances/_components/instance-settings-modal';
import type { SandboxInfo } from '@/lib/platform-client';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { useAdminSandboxes, useDeleteAdminSandbox, type AdminSandbox } from '@/hooks/admin/use-admin-sandboxes';
import { useAdminAccounts, useAdminAccountUsers, useAdminGrantCredits, type AdminAccount } from '@/hooks/admin/use-admin-accounts';
import { useAccessRequests, useApproveRequest, useRejectRequest, type AccessRequest } from '@/hooks/admin/use-access-requests';

export type AdminSection = 'instances' | 'accounts' | 'access-requests';

export const ADMIN_SECTION_META: Record<AdminSection, { title: string; description: string }> = {
  instances: {
    title: 'Instance Management',
    description: 'Inspect every machine, open shared instance settings, and manage lifecycle actions across all accounts.',
  },
  accounts: {
    title: 'Account Management',
    description: 'Inspect accounts, users, billing state, and credit balances — including reimbursements and manual adjustments.',
  },
  'access-requests': {
    title: 'Access Requests',
    description: 'Review allowlist / early-access signup requests and approve or reject them.',
  },
};

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
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
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

function ensureAdmin(adminRole: { isAdmin?: boolean } | undefined, roleLoading: boolean) {
  if (roleLoading) return <Skeleton className="h-96 w-full" />;
  if (!adminRole?.isAdmin) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="text-center space-y-3">
          <ShieldCheck className="h-12 w-12 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">Admin access required</h2>
        </div>
      </div>
    );
  }
  return null;
}

const PAGE_SIZE = 50;

export function AdminInstancesSection({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading);
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
  const [selectedSandbox, setSelectedSandbox] = useState<SandboxInfo | null>(null);

  const list = data?.sandboxes ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deleteMutation.mutateAsync(confirmDelete.sandboxId);
      toast.success(`Deleted instance ${confirmDelete.sandboxId.slice(0, 8)}`, {
        description: confirmDelete.provider === 'justavps' ? 'Removed from DB and JustaVPS machine deleted.' : 'Removed from DB.',
      });
    } catch (err: any) {
      toast.error('Failed to delete instance', { description: err.message });
    }
    setConfirmDelete(null);
  }, [confirmDelete, deleteMutation]);

  if (gate) return gate;

  return (
    <div className={embedded ? 'space-y-5' : 'min-h-screen bg-background'}>
      <div className={embedded ? 'space-y-5' : 'max-w-6xl mx-auto p-6 space-y-5'}>
        {!embedded && (
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Server className="h-6 w-6" />Admin Instances</h1>
              <p className="text-sm text-muted-foreground mt-1">All instances across every account · {total.toLocaleString()} total</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => router.push('/admin')}>Admin Home</Button>
              <Button variant="outline" onClick={() => router.push('/instances')} className="gap-2"><ArrowLeft className="h-4 w-4" />Back to Instances</Button>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input type="text" className="pl-8 h-8 text-sm" placeholder="Search by instance ID, name, account, email..." autoComplete="off" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
          <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="pooled">Pooled</SelectItem><SelectItem value="provisioning">Provisioning</SelectItem><SelectItem value="stopped">Stopped</SelectItem><SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={providerFilter || 'all'} onValueChange={(v) => setProviderFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue placeholder="Provider" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem><SelectItem value="justavps">JustAVPS</SelectItem><SelectItem value="daytona">Daytona</SelectItem><SelectItem value="local_docker">Local</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="h-8 gap-1.5"><RefreshCw className={cn('h-3.5 w-3.5', isFetching ? 'animate-spin' : '')} /></Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : list.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border border-foreground/[0.08] rounded-xl"><Server className="h-10 w-10 mx-auto mb-3 opacity-30" /><p className="text-sm">No instances match your filters</p></div>
        ) : (
          <div className={cn('border border-foreground/[0.08] rounded-xl overflow-hidden transition-opacity', isFetching ? 'opacity-60' : '')}>
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="w-[90px]">ID</TableHead><TableHead>Name</TableHead><TableHead>Account / Email</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead className="w-[150px]">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {list.map((sandbox) => (
                  <TableRow key={sandbox.sandboxId} className="group cursor-pointer" onClick={() => setSelectedSandbox(toSandboxInfo(sandbox))}>
                    <TableCell className="font-mono text-xs text-muted-foreground" title={sandbox.sandboxId}>{sandbox.sandboxId.slice(0, 8)}</TableCell>
                    <TableCell className="text-sm max-w-[140px] truncate" title={sandbox.name ?? undefined}>{sandbox.name ?? <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell><div className="flex flex-col min-w-0"><span className="text-sm truncate">{sandbox.accountName ?? '—'}</span>{sandbox.ownerEmail && <span className="text-xs text-muted-foreground truncate">{sandbox.ownerEmail}</span>}</div></TableCell>
                    <TableCell className="text-sm capitalize">{sandbox.provider ?? <span className="text-muted-foreground">&mdash;</span>}</TableCell>
                    <TableCell><StatusBadge status={sandbox.status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(sandbox.createdAt)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => router.push(`/instances/${sandbox.sandboxId}`)}>Connect</Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-500 hover:bg-red-500/10" onClick={() => setConfirmDelete(sandbox)}><Trash2 className="h-3.5 w-3.5" /></Button>
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
            <span>Page {page} of {pages} — {total.toLocaleString()} results</span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setPage(1)} disabled={page === 1} title="First page">«</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 gap-1" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 gap-1" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
              <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setPage(pages)} disabled={page === pages} title="Last page">»</Button>
            </div>
          </div>
        )}

        <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete Instance</DialogTitle><DialogDescription>Permanently delete <span className="font-mono text-foreground">{confirmDelete?.sandboxId.slice(0, 8)}</span>{confirmDelete?.provider === 'justavps' && ' and terminate the JustaVPS machine'}. This cannot be undone.</DialogDescription></DialogHeader>
            {confirmDelete && <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-lg px-4 py-3 space-y-1.5 text-sm"><div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>{confirmDelete.accountName ?? '—'}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Provider</span><span className="capitalize">{confirmDelete.provider ?? '—'}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{confirmDelete.status ?? '—'}</span></div></div>}
            <DialogFooter><Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleteMutation.isPending}>Cancel</Button><Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>{deleteMutation.isPending ? 'Deleting…' : 'Delete'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>

        <InstanceSettingsModal sandbox={selectedSandbox} open={!!selectedSandbox} onOpenChange={(open) => { if (!open) setSelectedSandbox(null); }} />
      </div>
    </div>
  );
}

function formatCredits(value: string | null) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

export function AdminAccountsSection({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminAccount | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Reimbursement');
  const [isExpiring, setIsExpiring] = useState(false);

  const accountsQuery = useAdminAccounts({ search, page: 1, limit: 100 });
  const usersQuery = useAdminAccountUsers(selected?.accountId ?? null);
  const grantCredits = useAdminGrantCredits();
  const totalCredits = useMemo(() => (accountsQuery.data?.accounts ?? []).reduce((sum, account) => sum + Number(account.balance ?? 0), 0), [accountsQuery.data?.accounts]);

  async function handleGrantCredits() {
    if (!selected) return;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter a valid positive credit amount');
      return;
    }
    try {
      await grantCredits.mutateAsync({ accountId: selected.accountId, amount: parsed, description: description.trim() || 'Admin credit adjustment', isExpiring });
      toast.success('Credits granted', { description: `${parsed.toFixed(2)} credits added to ${selected.name || selected.accountId}` });
      setAmount('');
    } catch (error) {
      toast.error('Failed to grant credits', { description: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  if (gate) return gate;

  return (
    <div className={embedded ? 'space-y-5' : 'min-h-screen bg-background'}>
      <div className={embedded ? 'space-y-5' : 'max-w-6xl mx-auto p-6 space-y-5'}>
        {!embedded && (
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Users className="h-6 w-6" /> Admin Accounts</h1>
              <p className="text-sm text-muted-foreground mt-1">Accounts, users, billing state, and credit balances · {accountsQuery.data?.total ?? 0} total accounts · {totalCredits.toFixed(2)} credits tracked</p>
            </div>
            <div className="flex items-center gap-2"><Button variant="outline" onClick={() => router.push('/admin')}>Admin Home</Button><Button variant="outline" onClick={() => router.push('/instances')} className="gap-2"><ArrowLeft className="h-4 w-4" />Back to Instances</Button></div>
          </div>
        )}

        <div className="relative max-w-md"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search account, owner email, account ID..." className="pl-8 h-9" /></div>

        {accountsQuery.isLoading ? (
          <div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : (
          <div className="border border-foreground/[0.08] rounded-xl overflow-hidden divide-y divide-border/60">
            {(accountsQuery.data?.accounts ?? []).map((account) => (
              <button key={account.accountId} type="button" onClick={() => setSelected(account)} className="w-full text-left px-4 py-3 hover:bg-muted/20 transition-colors">
                <div className="flex items-center justify-between gap-4"><div className="min-w-0"><div className="text-sm font-medium truncate">{account.name || 'Unnamed account'}</div><div className="text-xs text-muted-foreground truncate">{account.ownerEmail || 'No owner email'} · {account.accountId}</div></div><div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0"><span>{account.memberCount} users</span><span>{account.tier || 'free'}</span><span className="font-mono text-foreground">{formatCredits(account.balance)} cr</span></div></div>
              </button>
            ))}
            {!accountsQuery.data?.accounts?.length && <div className="px-4 py-12 text-center text-sm text-muted-foreground">No accounts found.</div>}
          </div>
        )}

        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>{selected?.name || 'Account'}</DialogTitle><DialogDescription>{selected?.ownerEmail || 'No owner email'} · {selected?.accountId}</DialogDescription></DialogHeader>
            {selected && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Total credits</div><div className="text-lg font-semibold">{formatCredits(selected.balance)}</div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Expiring</div><div className="text-lg font-semibold">{formatCredits(selected.expiringCredits)}</div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Permanent</div><div className="text-lg font-semibold">{formatCredits(selected.nonExpiringCredits)}</div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Daily</div><div className="text-lg font-semibold">{formatCredits(selected.dailyCreditsBalance)}</div></div>
                </div>
                <div className="grid md:grid-cols-[1.2fr,0.8fr] gap-6">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium"><Users className="h-4 w-4" /> Users</div>
                    <div className="border rounded-lg divide-y">
                      {usersQuery.isLoading ? <div className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading users…</div> : (usersQuery.data?.users ?? []).map((user) => <div key={user.user_id} className="px-4 py-3 text-sm flex items-center justify-between gap-3"><div className="min-w-0"><div className="truncate">{user.email}</div><div className="text-xs text-muted-foreground font-mono truncate">{user.user_id}</div></div><div className="text-xs text-muted-foreground uppercase tracking-wide">{user.account_role}</div></div>)}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium"><CreditCard className="h-4 w-4" /> Billing & credits</div>
                    <div className="rounded-lg border p-4 space-y-3 text-sm">
                      <div><span className="text-muted-foreground">Tier:</span> <span className="font-medium ml-1">{selected.tier || 'free'}</span></div>
                      <div><span className="text-muted-foreground">Provider:</span> <span className="font-medium ml-1">{selected.provider || '—'}</span></div>
                      <div><span className="text-muted-foreground">Payment status:</span> <span className="font-medium ml-1">{selected.paymentStatus || '—'}</span></div>
                      <div><span className="text-muted-foreground">Plan:</span> <span className="font-medium ml-1">{selected.planType || '—'}</span></div>
                      <div><span className="text-muted-foreground">Billing email:</span> <span className="font-medium ml-1 break-all">{selected.billingCustomerEmail || '—'}</span></div>
                    </div>
                    <div className="rounded-lg border p-4 space-y-3">
                      <div className="text-sm font-medium">Grant credits</div>
                      <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (e.g. 25)" />
                      <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Reason / note" />
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isExpiring} onChange={(e) => setIsExpiring(e.target.checked)} />Grant as expiring credits</label>
                      <Button onClick={handleGrantCredits} disabled={grantCredits.isPending} className="w-full">{grantCredits.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}Add credits</Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function AccessStatusBadge({ status }: { status: AccessRequest['status'] }) {
  switch (status) {
    case 'pending': return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> Pending</Badge>;
    case 'approved': return <Badge variant="highlight" className="gap-1"><CheckCircle className="h-3 w-3" /> Approved</Badge>;
    case 'rejected': return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Rejected</Badge>;
  }
}

export function AdminAccessRequestsSection({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading);
  const [activeTab, setActiveTab] = useState<string>('pending');
  const [confirmDialog, setConfirmDialog] = useState<{ request: AccessRequest; action: 'approve' | 'reject' } | null>(null);
  const { data, isLoading } = useAccessRequests({ status: activeTab === 'all' ? undefined : activeTab });
  const approveMutation = useApproveRequest();
  const rejectMutation = useRejectRequest();

  if (gate) return gate;

  const summary = data?.summary || { pending: 0, approved: 0, rejected: 0 };
  const requests = data?.requests || [];

  async function handleAction() {
    if (!confirmDialog) return;
    const { request, action } = confirmDialog;
    try {
      if (action === 'approve') {
        await approveMutation.mutateAsync(request.id);
        toast.success(`Approved ${request.email}`, { description: 'Email added to allowlist. They can now sign up.' });
      } else {
        await rejectMutation.mutateAsync(request.id);
        toast.success(`Rejected ${request.email}`);
      }
    } catch (err: any) {
      toast.error(`Failed to ${action} request`, { description: err.message });
    }
    setConfirmDialog(null);
  }

  const isActioning = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className={embedded ? 'space-y-6' : 'min-h-screen bg-background'}>
      <div className={embedded ? 'space-y-6' : 'max-w-6xl mx-auto p-6 space-y-6'}>
        {!embedded && (
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><UserPlus className="h-6 w-6" />Access Requests</h1>
              <p className="text-sm text-muted-foreground mt-1">Review and manage early access requests</p>
            </div>
            <div className="flex items-center gap-2"><Button variant="outline" onClick={() => router.push('/admin')}>Admin Home</Button><Button variant="outline" onClick={() => router.push('/instances')} className="gap-2"><ArrowLeft className="h-4 w-4" />Back to Instances</Button></div>
            <div className="flex gap-3">
              <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-lg px-4 py-2 text-center min-w-[80px]"><p className="text-lg font-semibold text-amber-500">{summary.pending}</p><p className="text-[11px] text-muted-foreground">Pending</p></div>
              <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-lg px-4 py-2 text-center min-w-[80px]"><p className="text-lg font-semibold text-green-500">{summary.approved}</p><p className="text-[11px] text-muted-foreground">Approved</p></div>
              <div className="bg-foreground/[0.04] border border-foreground/[0.08] rounded-lg px-4 py-2 text-center min-w-[80px]"><p className="text-lg font-semibold text-red-500">{summary.rejected}</p><p className="text-[11px] text-muted-foreground">Rejected</p></div>
            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="pending" className="gap-1.5"><Clock className="h-3.5 w-3.5" />Pending{summary.pending > 0 && <span className="ml-1 text-[10px] bg-amber-500/20 text-amber-500 px-1.5 py-0.5 rounded-full font-medium">{summary.pending}</span>}</TabsTrigger>
            <TabsTrigger value="approved" className="gap-1.5"><CheckCircle className="h-3.5 w-3.5" />Approved</TabsTrigger>
            <TabsTrigger value="rejected" className="gap-1.5"><XCircle className="h-3.5 w-3.5" />Rejected</TabsTrigger>
            <TabsTrigger value="all" className="gap-1.5">All</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : requests.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-muted/10 py-16 text-center text-sm text-muted-foreground">No requests found for this filter.</div>
        ) : (
          <div className="border border-foreground/[0.08] rounded-xl overflow-hidden">
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead><TableHead className="w-[180px]">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {requests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">{request.email}</TableCell>
                    <TableCell><AccessStatusBadge status={request.status} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(request.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {request.status === 'pending' ? (
                          <>
                            <Button size="sm" onClick={() => setConfirmDialog({ request, action: 'approve' })}>Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => setConfirmDialog({ request, action: 'reject' })}>Reject</Button>
                          </>
                        ) : <span className="text-xs text-muted-foreground">No actions</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{confirmDialog?.action === 'approve' ? 'Approve request?' : 'Reject request?'}</DialogTitle><DialogDescription>{confirmDialog?.request.email}</DialogDescription></DialogHeader>
            <DialogFooter><Button variant="outline" onClick={() => setConfirmDialog(null)} disabled={isActioning}>Cancel</Button><Button onClick={handleAction} disabled={isActioning}>{isActioning ? 'Working…' : confirmDialog?.action === 'approve' ? 'Approve' : 'Reject'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
