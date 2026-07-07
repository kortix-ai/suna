'use client';

import { useTranslations } from 'next-intl';

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
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAccessRequests,
  useApproveRequest,
  useRejectRequest,
  type AccessRequest,
} from '@/hooks/admin/use-access-requests';
import {
  useAdminAccounts,
  useAdminAccountUsers,
  useAdminGrantCredits,
  type AdminAccount,
} from '@/hooks/admin/use-admin-accounts';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import {
  useAdminSandboxes,
  useDeleteAdminSandbox,
  type AdminSandbox,
} from '@/hooks/admin/use-admin-sandboxes';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export type AdminSection = 'instances' | 'accounts' | 'access-requests';

export const ADMIN_SECTION_META: Record<AdminSection, { title: string; description: string }> = {
  instances: {
    title: 'Instance Management',
    description:
      'Inspect every machine, open shared instance settings, and manage lifecycle actions across all accounts.',
  },
  accounts: {
    title: 'Account Management',
    description:
      'Inspect accounts, users, billing state, and credit balances — including reimbursements and manual adjustments.',
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
    case 'provisioning':
      return (
        <Badge variant="warning" className="gap-1">
          {status}
        </Badge>
      );
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
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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

function ensureAdmin(
  adminRole: { isAdmin?: boolean } | undefined,
  roleLoading: boolean,
  tHardcodedUi: ReturnType<typeof useTranslations>,
) {
  if (roleLoading) return <Skeleton className="h-96 w-full" />;
  if (!adminRole?.isAdmin) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="space-y-3 text-center">
          <ShieldCheck className="text-muted-foreground/40 mx-auto h-12 w-12" />
          <h2 className="text-lg font-medium">
            {tHardcodedUi.raw(
              'componentsAdminAdminDashboardSections.line122JsxTextAdminAccessRequired',
            )}
          </h2>
        </div>
      </div>
    );
  }
  return null;
}

const PAGE_SIZE = 50;

export function AdminInstancesSection({ embedded = false }: { embedded?: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading, tHardcodedUi);
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(searchInput, 350);

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

  if (gate) return gate;

  return (
    <div className={embedded ? 'space-y-5' : 'bg-background min-h-screen'}>
      <div className={embedded ? 'space-y-5' : 'mx-auto max-w-6xl space-y-5 p-6'}>
        {!embedded && (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <Server className="h-6 w-6" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line190JsxTextAdminInstances',
                )}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line191JsxTextAllInstancesAcrossEveryAccount',
                )}
                {total.toLocaleString()} total
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => router.push('/admin')}>
                {tHardcodedUi.raw('componentsAdminAdminDashboardSections.line194JsxTextAdminHome')}
              </Button>
              <Button variant="outline" onClick={() => router.push('/instances')} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line195JsxTextBackToInstances',
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              type="text"
              className="h-8 pl-8 text-sm"
              placeholder={tHardcodedUi.raw(
                'componentsAdminAdminDashboardSections.line203JsxAttrPlaceholderSearchByInstanceIdNameAccountEmail',
              )}
              autoComplete="off"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <Select
            value={statusFilter || 'all'}
            onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="h-8 w-[130px] text-sm">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line208JsxTextAllStatuses',
                )}
              </SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pooled">Pooled</SelectItem>
              <SelectItem value="provisioning">Provisioning</SelectItem>
              <SelectItem value="stopped">Stopped</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={providerFilter || 'all'}
            onValueChange={(v) => setProviderFilter(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="h-8 w-[130px] text-sm">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line214JsxTextAllProviders',
                )}
              </SelectItem>
              <SelectItem value="justavps">JustAVPS</SelectItem>
              <SelectItem value="managed">Managed</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-8 gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching ? 'animate-spin' : '')} />
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="text-muted-foreground border-foreground/[0.08] rounded-2xl border py-16 text-center">
            <Server className="mx-auto mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">
              {tHardcodedUi.raw(
                'componentsAdminAdminDashboardSections.line223JsxTextNoInstancesMatchYourFilters',
              )}
            </p>
          </div>
        ) : (
          <div
            className={cn(
              'border-foreground/[0.08] overflow-hidden rounded-2xl border transition-opacity',
              isFetching ? 'opacity-60' : '',
            )}
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[90px]">ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>
                    {tHardcodedUi.raw(
                      'componentsAdminAdminDashboardSections.line227JsxTextAccountEmail',
                    )}
                  </TableHead>
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
                    className="group"
                  >
                    <TableCell
                      className="text-muted-foreground font-mono text-xs"
                      title={sandbox.sandboxId}
                    >
                      {sandbox.sandboxId.slice(0, 8)}
                    </TableCell>
                    <TableCell
                      className="max-w-[140px] truncate text-sm"
                      title={sandbox.name ?? undefined}
                    >
                      {sandbox.name ?? (
                        <span className="text-muted-foreground">
                          {tHardcodedUi.raw(
                            'componentsAdminAdminDashboardSections.line232JsxTextMdash',
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{sandbox.accountName ?? '—'}</span>
                        {sandbox.ownerEmail && (
                          <span className="text-muted-foreground truncate text-xs">
                            {sandbox.ownerEmail}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {sandbox.provider ?? (
                        <span className="text-muted-foreground">
                          {tHardcodedUi.raw(
                            'componentsAdminAdminDashboardSections.line234JsxTextMdash',
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={sandbox.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(sandbox.createdAt)}
                    </TableCell>
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
                          className="text-muted-foreground hover:text-foreground h-7 w-7 p-0 opacity-0 transition-opacity group-hover:opacity-100"
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
          <div className="text-muted-foreground flex items-center justify-between text-sm">
            <span>
              Page {page} of {pages} — {total.toLocaleString()} results
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setPage(1)}
                disabled={page === 1}
                title={tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line254JsxAttrTitleFirstPage',
                )}
              >
                «
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2"
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page === pages}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setPage(pages)}
                disabled={page === pages}
                title={tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line257JsxAttrTitleLastPage',
                )}
              >
                »
              </Button>
            </div>
          </div>
        )}

        <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
          <DialogContent className="gap-0 overflow-hidden p-0">
            <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line264JsxTextDeleteInstance',
                )}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-sm">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line264JsxTextPermanentlyDelete',
                )}
                <span className="text-foreground font-mono">
                  {confirmDelete?.sandboxId.slice(0, 8)}
                </span>
                {confirmDelete?.provider === 'justavps' && ' and terminate the JustaVPS machine'}
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line264JsxTextThisCannotBeUndone',
                )}
              </DialogDescription>
            </DialogHeader>
            {confirmDelete && (
              <div className="px-6 py-5">
                <div className="bg-foreground/[0.04] border-foreground/[0.08] space-y-1.5 rounded-2xl border px-4 py-3 text-sm">
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
              </div>
            )}
            <div className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(null)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function formatCredits(value: string | null) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

export function AdminAccountsSection({ embedded = false }: { embedded?: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading, tHardcodedUi);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminAccount | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Reimbursement');
  const [isExpiring, setIsExpiring] = useState(false);

  const accountsQuery = useAdminAccounts({ search, page: 1, limit: 100 });
  const usersQuery = useAdminAccountUsers(selected?.accountId ?? null);
  const grantCredits = useAdminGrantCredits();
  const totalCredits = useMemo(
    () =>
      (accountsQuery.data?.accounts ?? []).reduce(
        (sum, account) => sum + Number(account.balance ?? 0),
        0,
      ),
    [accountsQuery.data?.accounts],
  );

  async function handleGrantCredits() {
    if (!selected) return;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter a valid positive credit amount');
      return;
    }
    try {
      await grantCredits.mutateAsync({
        accountId: selected.accountId,
        amount: parsed,
        description: description.trim() || 'Admin credit adjustment',
        isExpiring,
      });
      toast.success('Credits granted', {
        description: `${parsed.toFixed(2)} credits added to ${selected.name || selected.accountId}`,
      });
      setAmount('');
    } catch (error) {
      toast.error('Failed to grant credits', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (gate) return gate;

  return (
    <div className={embedded ? 'space-y-5' : 'bg-background min-h-screen'}>
      <div className={embedded ? 'space-y-5' : 'mx-auto max-w-6xl space-y-5 p-6'}>
        {!embedded && (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <Users className="h-6 w-6" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line320JsxTextAdminAccounts',
                )}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line321JsxTextAccountsUsersBillingStateAndCreditBalances',
                )}
                {accountsQuery.data?.total ?? 0}
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line321JsxTextTotalAccounts',
                )}
                {totalCredits.toFixed(2)}
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line321JsxTextCreditsTracked',
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => router.push('/admin')}>
                {tHardcodedUi.raw('componentsAdminAdminDashboardSections.line323JsxTextAdminHome')}
              </Button>
              <Button variant="outline" onClick={() => router.push('/instances')} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line323JsxTextBackToInstances',
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="relative max-w-md">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tHardcodedUi.raw(
              'componentsAdminAdminDashboardSections.line327JsxAttrPlaceholderSearchAccountOwnerEmailAccountId',
            )}
            className="h-9 pl-8"
          />
        </div>

        {accountsQuery.isLoading ? (
          <div className="space-y-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <div className="border-foreground/[0.08] divide-border divide-y overflow-hidden rounded-2xl border">
            {(accountsQuery.data?.accounts ?? []).map((account) => (
              <button
                key={account.accountId}
                type="button"
                onClick={() => setSelected(account)}
                className="hover:bg-muted/20 w-full px-4 py-3 text-left transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {account.name || 'Unnamed account'}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {account.ownerEmail || 'No owner email'} · {account.accountId}
                    </div>
                  </div>
                  <div className="text-muted-foreground flex shrink-0 items-center gap-4 text-xs">
                    <span>{account.memberCount} users</span>
                    <span>{account.tier || 'free'}</span>
                    <span className="text-foreground font-mono">
                      {formatCredits(account.balance)} cr
                    </span>
                  </div>
                </div>
              </button>
            ))}
            {!accountsQuery.data?.accounts?.length && (
              <div className="text-muted-foreground px-4 py-12 text-center text-sm">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line338JsxTextNoAccountsFound',
                )}
              </div>
            )}
          </div>
        )}

        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
            <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                {selected?.name || 'Account'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-sm">
                {selected?.ownerEmail || 'No owner email'} · {selected?.accountId}
              </DialogDescription>
            </DialogHeader>
            {selected && (
              <div className="space-y-6 px-6 py-5">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border p-3">
                    <div className="text-muted-foreground text-xs">
                      {tHardcodedUi.raw(
                        'componentsAdminAdminDashboardSections.line348JsxTextTotalCredits',
                      )}
                    </div>
                    <div className="text-lg font-semibold">{formatCredits(selected.balance)}</div>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <div className="text-muted-foreground text-xs">Expiring</div>
                    <div className="text-lg font-semibold">
                      {formatCredits(selected.expiringCredits)}
                    </div>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <div className="text-muted-foreground text-xs">Permanent</div>
                    <div className="text-lg font-semibold">
                      {formatCredits(selected.nonExpiringCredits)}
                    </div>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <div className="text-muted-foreground text-xs">Daily</div>
                    <div className="text-lg font-semibold">
                      {formatCredits(selected.dailyCreditsBalance)}
                    </div>
                  </div>
                </div>
                <div className="grid gap-6 md:grid-cols-[1.2fr,0.8fr]">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Users className="h-4 w-4" /> Users
                    </div>
                    <div className="divide-y rounded-2xl border">
                      {usersQuery.isLoading ? (
                        <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {tHardcodedUi.raw(
                            'componentsAdminAdminDashboardSections.line357JsxTextLoadingUsers',
                          )}
                        </div>
                      ) : (
                        (usersQuery.data?.users ?? []).map((user) => (
                          <div
                            key={user.user_id}
                            className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                          >
                            <div className="min-w-0">
                              <div className="truncate">{user.email}</div>
                              <div className="text-muted-foreground truncate font-mono text-xs">
                                {user.user_id}
                              </div>
                            </div>
                            <div className="text-muted-foreground text-xs tracking-wide uppercase">
                              {user.account_role}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <CreditCard className="h-4 w-4" />
                      {tHardcodedUi.raw(
                        'componentsAdminAdminDashboardSections.line361JsxTextBillingCredits',
                      )}
                    </div>
                    <div className="space-y-3 rounded-2xl border p-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Tier:</span>{' '}
                        <span className="ml-1 font-medium">{selected.tier || 'free'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Provider:</span>{' '}
                        <span className="ml-1 font-medium">{selected.provider || '—'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {tHardcodedUi.raw(
                            'componentsAdminAdminDashboardSections.line365JsxTextPaymentStatus',
                          )}
                        </span>{' '}
                        <span className="ml-1 font-medium">{selected.paymentStatus || '—'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Plan:</span>{' '}
                        <span className="ml-1 font-medium">{selected.planType || '—'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {tHardcodedUi.raw(
                            'componentsAdminAdminDashboardSections.line367JsxTextBillingEmail',
                          )}
                        </span>{' '}
                        <span className="ml-1 font-medium break-all">
                          {selected.billingCustomerEmail || '—'}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-3 rounded-2xl border p-4">
                      <div className="text-sm font-medium">
                        {tHardcodedUi.raw(
                          'componentsAdminAdminDashboardSections.line370JsxTextGrantCredits',
                        )}
                      </div>
                      <Input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder={tHardcodedUi.raw(
                          'componentsAdminAdminDashboardSections.line371JsxAttrPlaceholderAmountEG25',
                        )}
                      />
                      <Input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={tHardcodedUi.raw(
                          'componentsAdminAdminDashboardSections.line372JsxAttrPlaceholderReasonNote',
                        )}
                      />
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={isExpiring}
                          onCheckedChange={(checked) => setIsExpiring(checked === true)}
                        />
                        {tHardcodedUi.raw(
                          'componentsAdminAdminDashboardSections.line373JsxTextGrantAsExpiringCredits',
                        )}
                      </label>
                      <Button
                        onClick={handleGrantCredits}
                        disabled={grantCredits.isPending}
                        className="w-full"
                      >
                        {grantCredits.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        {tHardcodedUi.raw(
                          'componentsAdminAdminDashboardSections.line374JsxTextAddCredits',
                        )}
                      </Button>
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
    case 'pending':
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" /> Pending
        </Badge>
      );
    case 'approved':
      return (
        <Badge variant="highlight" className="gap-1">
          <CheckCircle className="h-3 w-3" /> Approved
        </Badge>
      );
    case 'rejected':
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" /> Rejected
        </Badge>
      );
  }
}

export function AdminAccessRequestsSection({ embedded = false }: { embedded?: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const gate = ensureAdmin(adminRole, roleLoading, tHardcodedUi);
  const [activeTab, setActiveTab] = useState<string>('pending');
  const [confirmDialog, setConfirmDialog] = useState<{
    request: AccessRequest;
    action: 'approve' | 'reject';
  } | null>(null);
  const { data, isLoading } = useAccessRequests({
    status: activeTab === 'all' ? undefined : activeTab,
  });
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
        toast.success(`Approved ${request.email}`, {
          description: 'Email added to allowlist. They can now sign up.',
        });
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
    <div className={embedded ? 'space-y-6' : 'bg-background min-h-screen'}>
      <div className={embedded ? 'space-y-6' : 'mx-auto max-w-6xl space-y-6 p-6'}>
        {!embedded && (
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <UserPlus className="h-6 w-6" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line435JsxTextAccessRequests',
                )}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line436JsxTextReviewAndManageEarlyAccessRequests',
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => router.push('/admin')}>
                {tHardcodedUi.raw('componentsAdminAdminDashboardSections.line438JsxTextAdminHome')}
              </Button>
              <Button variant="outline" onClick={() => router.push('/instances')} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                {tHardcodedUi.raw(
                  'componentsAdminAdminDashboardSections.line438JsxTextBackToInstances',
                )}
              </Button>
            </div>
            <div className="flex gap-3">
              <div className="bg-foreground/[0.04] border-foreground/[0.08] min-w-[80px] rounded-2xl border px-4 py-2 text-center">
                <p className="text-lg font-semibold text-amber-500">{summary.pending}</p>
                <p className="text-muted-foreground text-xs">Pending</p>
              </div>
              <div className="bg-foreground/[0.04] border-foreground/[0.08] min-w-[80px] rounded-2xl border px-4 py-2 text-center">
                <p className="text-lg font-semibold text-green-500">{summary.approved}</p>
                <p className="text-muted-foreground text-xs">Approved</p>
              </div>
              <div className="bg-foreground/[0.04] border-foreground/[0.08] min-w-[80px] rounded-2xl border px-4 py-2 text-center">
                <p className="text-lg font-semibold text-red-500">{summary.rejected}</p>
                <p className="text-muted-foreground text-xs">Rejected</p>
              </div>
            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="pending" className="gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Pending
              {summary.pending > 0 && (
                <span className="ml-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-500">
                  {summary.pending}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="approved" className="gap-1.5">
              <CheckCircle className="h-3.5 w-3.5" />
              Approved
            </TabsTrigger>
            <TabsTrigger value="rejected" className="gap-1.5">
              <XCircle className="h-3.5 w-3.5" />
              Rejected
            </TabsTrigger>
            <TabsTrigger value="all" className="gap-1.5">
              All
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : requests.length === 0 ? (
          <div className="border-border/60 bg-muted/10 text-muted-foreground rounded-2xl border py-16 text-center text-sm">
            {tHardcodedUi.raw(
              'componentsAdminAdminDashboardSections.line459JsxTextNoRequestsFoundForThisFilter',
            )}
          </div>
        ) : (
          <div className="border-foreground/[0.08] overflow-hidden rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">{request.email}</TableCell>
                    <TableCell>
                      <AccessStatusBadge status={request.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(request.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {request.status === 'pending' ? (
                          <>
                            <Button
                              size="sm"
                              onClick={() => setConfirmDialog({ request, action: 'approve' })}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmDialog({ request, action: 'reject' })}
                            >
                              Reject
                            </Button>
                          </>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsAdminAdminDashboardSections.line477JsxTextNoActions',
                            )}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
          <DialogContent className="gap-0 overflow-hidden p-0">
            <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                {confirmDialog?.action === 'approve' ? 'Approve request?' : 'Reject request?'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-sm">
                {confirmDialog?.request.email}
              </DialogDescription>
            </DialogHeader>
            <div className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
              <Button variant="ghost" onClick={() => setConfirmDialog(null)} disabled={isActioning}>
                Cancel
              </Button>
              <Button onClick={handleAction} disabled={isActioning}>
                {isActioning
                  ? 'Working…'
                  : confirmDialog?.action === 'approve'
                    ? 'Approve'
                    : 'Reject'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
