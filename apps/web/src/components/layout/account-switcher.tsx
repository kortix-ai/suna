'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronsUpDown,
  FolderGit2,
  Loader2,
  Plus,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  createAccount,
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
} from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export function AccountSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [createOpen, setCreateOpen] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  // Auto-select first account if none selected, or if the selected one is gone.
  useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return;
    if (!selectedAccountId || !accounts.find((a) => a.account_id === selectedAccountId)) {
      setSelectedAccountId(accounts[0].account_id);
    }
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);

  const selected =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0];

  if (accountsQuery.isLoading) {
    return <Skeleton className={cn('h-8 w-36 rounded-md', className)} />;
  }
  if (!selected) return null;

  const displayName = selected.name || (selected.personal_account ? 'Personal' : 'Account');
  const initial = displayName.charAt(0).toUpperCase();

  // Personal first, then alpha. Flat list — no Personal/Teams split.
  const sortedAccounts = [...(accountsQuery.data ?? [])].sort((a, b) => {
    if (a.personal_account && !b.personal_account) return -1;
    if (!a.personal_account && b.personal_account) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 gap-2 px-2 rounded-md text-foreground',
              'hover:bg-muted/50 data-[state=open]:bg-muted/60',
              className,
            )}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-[5px] border border-border/60 bg-muted/40 text-[10px] font-semibold text-foreground/80">
              {initial}
            </span>
            <span className="max-w-32 truncate text-[13px] font-medium">{displayName}</span>
            <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Accounts
          </DropdownMenuLabel>
          {sortedAccounts.map((account) => (
            <AccountItem
              key={account.account_id}
              account={account}
              active={account.account_id === selected.account_id}
              onSelect={() => setSelectedAccountId(account.account_id)}
            />
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => router.push(`/accounts/${selected.account_id}`)}
            className="gap-2"
          >
            <SettingsIcon className="h-4 w-4" />
            Account settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Create account
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push('/accounts')} className="gap-2">
            <Users className="h-4 w-4" />
            Manage accounts
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account) => {
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
        }}
      />
    </>
  );
}

function AccountItem({
  account,
  active,
  onSelect,
}: {
  account: KortixAccount;
  active: boolean;
  onSelect: () => void;
}) {
  const label = account.name || (account.personal_account ? 'Personal' : 'Account');
  return (
    <DropdownMenuItem onSelect={onSelect} className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border/70 bg-muted/40 text-[10px] font-medium">
          {label.charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-sm">{label}</span>
        {account.personal_account && (
          <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
            Personal
          </Badge>
        )}
        {!account.personal_account && account.account_role && account.account_role !== 'owner' && (
          <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
            {account.account_role}
          </Badge>
        )}
      </div>
      {active && <Check className="h-3.5 w-3.5 text-foreground" />}
    </DropdownMenuItem>
  );
}

export function CreateAccountModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (account: KortixAccount) => void;
}) {
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: (account) => {
      toast.success('Account created');
      onCreated?.(account);
      setName('');
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to create account'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return toast.error('Account name is required');
    mutation.mutate({ name: trimmed });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setName(''); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-lg font-semibold tracking-tight">Create an account</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Group people, projects, and billing under one account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="account-name">Account name</Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme AGI"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              You can invite members and add projects after creation.
            </p>
          </div>
          <div className="-mx-6 mt-4 flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create account
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sibling pill rendered next to the AccountSwitcher in the header. Vercel
 * breadcrumb pattern: "/ Account / Project". Only renders on `/projects`
 * routes (list + detail) — keeps the header clean elsewhere.
 */
export function ProjectSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);

  const onProjectsRoute = pathname?.startsWith('/projects');
  const currentProjectId = pathname?.startsWith('/projects/') ? params?.id : undefined;

  const projectsQuery = useQuery({
    queryKey: ['projects', selectedAccountId],
    queryFn: () => listProjectsForAccount(selectedAccountId || undefined),
    enabled: !!selectedAccountId && !!onProjectsRoute,
    staleTime: 20_000,
  });

  if (!onProjectsRoute) return null;

  const current: KortixProject | undefined =
    currentProjectId && projectsQuery.data
      ? projectsQuery.data.find((p) => p.project_id === currentProjectId)
      : undefined;

  const label = current?.name || (currentProjectId ? 'Project' : 'Projects');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 gap-2 px-2 rounded-md text-foreground',
            'hover:bg-muted/50 data-[state=open]:bg-muted/60',
            className,
          )}
        >
          <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="max-w-40 truncate text-[13px] font-medium">{label}</span>
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Projects
        </DropdownMenuLabel>
        {projectsQuery.isLoading && (
          <div className="px-2 py-1.5">
            <Skeleton className="h-7 w-full" />
          </div>
        )}
        {!projectsQuery.isLoading && (projectsQuery.data ?? []).length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No projects yet</div>
        )}
        {(projectsQuery.data ?? []).slice(0, 8).map((project) => (
          <DropdownMenuItem
            key={project.project_id}
            onSelect={() => router.push(`/projects/${project.project_id}`)}
            className="flex items-center justify-between gap-3"
          >
            <span className="truncate text-sm">{project.name}</span>
            {project.project_id === currentProjectId && (
              <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/projects')} className="gap-2">
          <FolderGit2 className="h-4 w-4" />
          All projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
