'use client';

/**
 * The API keys surface: one list, one create flow, plain words.
 *
 * **What this replaces.** Two cards with two vocabularies —
 * `service-accounts-card.tsx` ("machine identities for CI/CD… attach policies
 * just like a member… pick the service account as the principal") and
 * `features/accounts/settings/cli-tokens-tab.tsx` ("CLI PATs"), which was
 * mounted on no screen at all. So the CLI key you made was invisible from the
 * tab named API keys, and the tab named API keys offered only the kind of key
 * most people did not want. Jay's report — "there is no way to actually create
 * the API key" — was that gap, not a missing button. Both source files are
 * deleted; this is the only implementation now.
 *
 * **One list.** `buildApiKeyRows` (`api-key-rows.ts`) merges both backends into
 * one `ApiKeyRow[]`, so the reader sees keys, not two implementations of a key.
 * The distinction that survives is the one that changes behaviour, and it is
 * spelled out in the create form rather than in a noun: a personal key acts as
 * you, an automation key acts as itself.
 *
 * **What is deliberately not here.** No "Attach policies" link. The old card
 * pointed at `/accounts/{id}/tokens/{serviceAccountId}`, a page that looks the
 * id up in `listAccountTokens` — so for a service account it renders "Token not
 * found", and it holds no policy editor for any id. Sending someone there was
 * worse than not offering it.
 *
 * **Empty is empty.** When a workspace has no keys this renders `null` — no
 * icon, no headline, no second Create button. Jay, 2026-08-12: "If there is no
 * service account yet, don't show the empty state." The create action lives in
 * the pane header where the eye already lands.
 *
 * **One layout, borrowed whole.** Jay, later the same day: "for the API key
 * table layout, I want you to use the same layout that is used in this secret
 * tab." So every piece of chrome here is now `secrets-view.tsx`'s piece — the
 * shared bordered `Table` instead of a hand-rolled `<table>` and three local
 * cell constants, `InputGroupSearch` instead of a bare `Input type="search"`,
 * a `DotsThree` row menu instead of inline ghost buttons, and the matching
 * skeleton. Two surfaces that show a list of credentials should not have two
 * dialects for it.
 *
 * Two things came with that pass. The toolbar's six filter targets collapsed
 * into one menu (`ApiKeyFilterValue` in `api-key-rows.ts` holds the argument),
 * and Status became a `Badge` with a glyph (`STATUS_BADGE` below).
 */

import { type ComponentProps, useState } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { MFA_REQUIRED_EVENT } from '@/features/auth/mfa-step-up';
import { ErrorState } from '@/features/layout/section/error-state';
import { useCopy } from '@/hooks/use-copy';
import {
  createServiceAccountApi,
  deleteServiceAccountApi,
  disableServiceAccountApi,
  getPatPolicy,
  listServiceAccountsApi,
} from '@/lib/iam-client';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import {
  createAccountToken,
  listAccountTokens,
  listProjectsForAccount,
  revokeAccountToken,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon,
  ClockIcon,
  CopyIcon,
  DotsThreeIcon,
  type Icon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { NEVER_EXPIRES, defaultExpiryOption, expiresAtIso, expiryOptions } from './api-key-expiry';
import {
  type ApiKeyFilterValue,
  type ApiKeyKind,
  type ApiKeyRow,
  type ApiKeyStatus,
  apiKeyFilter,
  buildApiKeyRows,
  countApiKeys,
  filterApiKeyRows,
} from './api-key-rows';

/** Sentinel Select value for "not scoped to one project". */
const WHOLE_WORKSPACE = '__workspace__';

/**
 * How each state reads in the Status column.
 *
 * Jay, 2026-08-12: "for the status, I want you to use the badge icon." The
 * column used to be the bare word, with a small green dot in front of the live
 * ones — so two of the three states were unbounded text floating in a cell,
 * and the one mark on offer only ever appeared on the default state. A `Badge`
 * gives all three the same edge, and the glyph lands before the word is read.
 *
 * `revoked` is `muted`, not `destructive`: someone chose to revoke it, and a
 * column of red would put the alarm on the wrong thing. Only `expired` — the
 * state nobody chose, and the one that silently stops a CI job — takes a
 * warning colour.
 */
const STATUS_BADGE: Record<
  ApiKeyStatus,
  { label: string; variant: ComponentProps<typeof Badge>['variant']; icon: Icon }
> = {
  active: { label: 'Active', variant: 'success', icon: CheckCircleIcon },
  expired: { label: 'Expired', variant: 'update', icon: ClockIcon },
  revoked: { label: 'Revoked', variant: 'muted', icon: ProhibitIcon },
};

/** The type half of the one filter. The status half is `STATUS_BADGE`'s keys. */
const KIND_OPTIONS: { value: ApiKeyKind; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'automation', label: 'Automation' },
];

const STATUS_OPTIONS: ApiKeyStatus[] = ['active', 'expired', 'revoked'];

/** The line under each filter option: what picking it leads to, before it is picked. */
function countLabel(count: number): string {
  if (count === 0) return 'None';
  return `${count} ${count === 1 ? 'key' : 'keys'}`;
}

const TOKENS_KEY = (accountId: string) => ['account-tokens', accountId];
const SERVICE_ACCOUNTS_KEY = (accountId: string) => ['service-accounts', accountId];

/**
 * A workspace can require a second factor before its keys are readable at all
 * (`iam/dispatcher.ts` turns that denial into `403 { code:
 * 'account_mfa_required' }`). That is the one denial a person can fix from
 * here, so it gets a banner with the step-up action rather than a red error.
 */
function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'account_mfa_required';
}

function useInvalidateKeys(accountId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: TOKENS_KEY(accountId) });
    queryClient.invalidateQueries({ queryKey: SERVICE_ACCOUNTS_KEY(accountId) });
  };
}

interface PendingAction {
  row: ApiKeyRow;
  action: 'revoke' | 'delete';
}

export interface ApiKeysListProps {
  accountId: string;
  /** `token.revoke` — hides every row action when false. */
  canManage: boolean;
}

/** The table itself. The create action is the caller's, so the pane header can own it. */
export function ApiKeysList({ accountId, canManage }: ApiKeysListProps) {
  const invalidate = useInvalidateKeys(accountId);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [search, setSearch] = useState('');
  /** One control, one axis — see `ApiKeyFilterValue` in `api-key-rows.ts`. */
  const [view, setView] = useState<ApiKeyFilterValue>('all');

  const tokensQuery = useQuery({
    queryKey: TOKENS_KEY(accountId),
    queryFn: () => listAccountTokens(accountId),
    staleTime: 30_000,
  });

  const serviceAccountsQuery = useQuery({
    queryKey: SERVICE_ACCOUNTS_KEY(accountId),
    queryFn: () => listServiceAccountsApi(accountId),
    staleTime: 30_000,
  });

  // Names only — a project-scoped key shows the project it is limited to
  // rather than a raw uuid.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
  });

  const revokeMutation = useMutation({
    // "Revoke" is one action to a reader and two endpoints underneath: a
    // personal key is revoked, an automation key is disabled (its row survives
    // for the audit trail). Both results are discarded — the list refetches —
    // so this returns void rather than a union of two response shapes.
    mutationFn: async (row: ApiKeyRow) => {
      if (row.kind === 'personal') await revokeAccountToken(row.id, accountId);
      else await disableServiceAccountApi(accountId, row.id);
    },
    onSuccess: () => {
      successToast('Key revoked');
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not revoke that key'),
  });

  const deleteMutation = useMutation({
    mutationFn: (row: ApiKeyRow) => deleteServiceAccountApi(accountId, row.id),
    onSuccess: () => {
      successToast('Key deleted');
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not delete that key'),
  });

  const isLoading = tokensQuery.isLoading || serviceAccountsQuery.isLoading;
  const error = tokensQuery.error ?? serviceAccountsQuery.error;

  if (isLoading) {
    // Shape-matched to the toolbar plus a few table rows, the same placeholder
    // `secrets-view.tsx` uses — so the block does not resize when data lands.
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 rounded-md" />
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-10 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    if (isMfaRequired(error)) {
      return (
        <InfoBanner
          tone="warning"
          title="Confirm it's you"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT))}
            >
              Verify
            </Button>
          }
        >
          This workspace asks for a second factor before showing its keys. The list refreshes on its
          own once you have verified.
        </InfoBanner>
      );
    }
    return (
      <ErrorState
        size="sm"
        title="Couldn't load your keys"
        description={error instanceof Error ? error.message : undefined}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              tokensQuery.refetch();
              serviceAccountsQuery.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const rows = buildApiKeyRows({
    tokens: tokensQuery.data,
    serviceAccounts: serviceAccountsQuery.data,
    projects: projectsQuery.data,
  });

  // No keys, no chrome — see this file's header comment. The toolbar goes with
  // them: a search field over nothing is furniture.
  if (rows.length === 0) return null;

  const counts = countApiKeys(rows);
  const visible = filterApiKeyRows(rows, { ...apiKeyFilter(view), search });
  const busy = revokeMutation.isPending || deleteMutation.isPending;

  // An option that leads to an empty table is not offered. The currently
  // selected one always survives, or revoking the last active key would make
  // the selection vanish out of the trigger while it was still in force.
  const inMenu = (value: ApiKeyFilterValue) => counts[value] > 0 || view === value;
  const statusOptions = STATUS_OPTIONS.filter(inMenu);
  const kindOptions = KIND_OPTIONS.filter((option) => inMenu(option.value));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* The Secrets toolbar, primitive for primitive — `InputGroupSearch`
            with the popover-variant input and its own clear button, rather
            than the bare `Input type="search"` this had. */}
        <InputGroupSearch className="min-w-0 sm:flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search keys"
            aria-label="Search keys"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setSearch('')} />
        </InputGroupSearch>

        {/* ONE control where there were two: a four-pill status strip and a
            type dropdown, six targets and two of them called "All". Both axes
            now live in this menu, one at a time — see `ApiKeyFilterValue` in
            `api-key-rows.ts` for why that costs nothing the search does not
            already cover. Each option carries what it leads to as a
            description, which `select.tsx` renders in the menu only, so the
            collapsed trigger stays a plain label. */}
        <Select value={view} onValueChange={(value) => setView(value as ApiKeyFilterValue)}>
          <SelectTrigger className="w-full shrink-0 sm:w-44" aria-label="Filter keys">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem size="sm" value="all" description={countLabel(counts.all)}>
              All keys
            </SelectItem>
            {statusOptions.length > 0 ? (
              <>
                <SelectSeparator />

                <SelectGroup>
                  <SelectLabel>Status</SelectLabel>
                  {statusOptions.map((value) => (
                    <SelectItem
                      size="sm"
                      key={value}
                      value={value}
                      description={countLabel(counts[value])}
                    >
                      {STATUS_BADGE[value].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            ) : null}
            {kindOptions.length > 0 ? (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Type</SelectLabel>
                  {kindOptions.map((option) => (
                    <SelectItem
                      size="sm"
                      key={option.value}
                      value={option.value}
                      description={countLabel(counts[option.value])}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            ) : null}
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          {search.trim() ? (
            <>
              No keys match <span className="text-foreground font-mono">{search.trim()}</span>.
            </>
          ) : (
            // Only reachable when the selection goes stale mid-session — revoke
            // the last active key while "Active" is showing. `inMenu` keeps that
            // option in the menu, so this names the way back out of it.
            'Nothing left under this filter. Choose “All keys” to see the rest.'
          )}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Key</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-[52px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <KeyTableRow
                key={`${row.kind}:${row.id}`}
                row={row}
                canManage={canManage}
                busy={busy && pending?.row.id === row.id}
                onRevoke={() => setPending({ row, action: 'revoke' })}
                onDelete={() => setPending({ row, action: 'delete' })}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.action === 'delete' ? 'Delete this key?' : 'Revoke this key?'}
        description={
          pending
            ? pending.action === 'delete'
              ? `Removes "${pending.row.name}" from this list for good, along with anything it was allowed to do.`
              : `"${pending.row.name}" stops working right away. Anything still using it — the CLI, a script, a CI job — starts getting turned away. This can't be undone.`
            : ''
        }
        confirmLabel={pending?.action === 'delete' ? 'Delete' : 'Revoke'}
        confirmVariant="destructive"
        isPending={busy}
        onConfirm={() => {
          if (!pending) return;
          if (pending.action === 'delete') deleteMutation.mutate(pending.row);
          else revokeMutation.mutate(pending.row);
        }}
      />
    </div>
  );
}

function KeyTableRow({
  row,
  canManage,
  busy,
  onRevoke,
  onDelete,
}: {
  row: ApiKeyRow;
  canManage: boolean;
  busy: boolean;
  onRevoke: () => void;
  onDelete: () => void;
}) {
  const live = row.status === 'active';
  const status = STATUS_BADGE[row.status];
  const canRevoke = live || row.status === 'expired';
  // A revoked personal key has no delete endpoint — it stays as a record. Only
  // an automation key can be cleared from the list.
  const canDelete = !canRevoke && row.kind === 'automation';

  return (
    <TableRow>
      {/* The Secrets identifier cell: one line for the name, one muted mono
          line under it, both middle-aligned. The `size-8` key tile that used to
          lead this cell is gone — once Status carries a badge, a tile that
          tinted green for the same bit was the second thing on the row saying
          "this one works". */}
      <TableCell className="max-w-[280px] align-middle">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'truncate text-sm font-medium',
                live ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {row.name}
            </span>
            {row.scopeLabel ? (
              <Badge variant="muted" size="xs" className="max-w-[120px] shrink-0 truncate">
                {row.scopeLabel}
              </Badge>
            ) : null}
          </div>
          <code className="text-muted-foreground truncate font-mono text-xs">{row.hint}</code>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground align-middle text-xs">
        {row.kind === 'automation' ? 'Automation' : 'Personal'}
      </TableCell>
      <TableCell className="align-middle">
        <Badge variant={status.variant} size="sm">
          <status.icon weight="fill" />
          {status.label}
        </Badge>
      </TableCell>
      {/* `tabular-nums` so the two date columns stay in their own gutters as
          rows re-render — "3 days ago" over "13 days ago" otherwise shifts. */}
      <TableCell className="text-muted-foreground align-middle text-xs tabular-nums">
        {relativeTime(row.createdAt)}
      </TableCell>
      <TableCell className="text-muted-foreground align-middle text-xs tabular-nums">
        {row.lastUsedAt ? relativeTime(row.lastUsedAt) : 'Never'}
      </TableCell>
      <TableCell className="align-middle">
        {/* Revoke and Delete moved into the Secrets row menu. They were bare
            ghost text buttons sitting in every row, so the table's most
            destructive action was also its most repeated word. */}
        {canManage && (canRevoke || canDelete) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={`Actions for ${row.name}`}>
                {busy ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <DotsThreeIcon className="size-3.5 shrink-0" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canRevoke ? (
                <DropdownMenuItem onClick={onRevoke}>
                  <ProhibitIcon className="size-3.5 shrink-0" />
                  Revoke key
                </DropdownMenuItem>
              ) : null}
              {canDelete ? (
                <DropdownMenuItem onClick={onDelete}>
                  <TrashIcon className="size-3.5 shrink-0" />
                  Delete key
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export interface CreateApiKeyDialogProps {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create, then show the secret once.
 *
 * Both halves live in one Modal on purpose: the secret is the only reason a
 * person opened this, and a dialog that closes and reopens somewhere else is
 * how a one-time secret gets lost.
 */
export function CreateApiKeyDialog({ accountId, open, onOpenChange }: CreateApiKeyDialogProps) {
  const invalidate = useInvalidateKeys(accountId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiKeyKind>('personal');
  const [scope, setScope] = useState<string>(WHOLE_WORKSPACE);
  const [expiry, setExpiry] = useState<string>(NEVER_EXPIRES);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  // Both queries are dialog-scoped: nothing fetches until someone actually
  // opens the form.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
    enabled: open,
  });
  const projects = projectsQuery.data ?? [];

  // Shares its key with `KeyRulesCard`, so opening this form while the rules
  // are on screen costs no second request.
  const policyQuery = useQuery({
    queryKey: ['iam-pat-policy', accountId],
    queryFn: () => getPatPolicy(accountId),
    staleTime: 30_000,
    enabled: open,
    retry: false,
  });
  const policy = policyQuery.data ?? null;
  const expiryChoices = expiryOptions(policy);
  // The policy lands after first paint, and it can remove the option currently
  // selected ("Never", once expiry is required). Re-point at a legal value
  // rather than submitting one the backend will reject.
  const selectedExpiry = expiryChoices.some((o) => o.value === expiry)
    ? expiry
    : defaultExpiryOption(policy);

  const mutation = useMutation({
    mutationFn: async () => {
      const expiresAt = expiresAtIso(selectedExpiry);
      if (kind === 'automation') {
        const sa = await createServiceAccountApi(accountId, {
          name: name.trim(),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        });
        return { name: sa.name, secret: sa.secret };
      }
      const token = await createAccountToken({
        name: name.trim(),
        accountId,
        ...(expiresAt ? { expiresAt } : {}),
        ...(scope === WHOLE_WORKSPACE ? {} : { projectId: scope }),
      });
      return { name: token.name, secret: token.secret_key };
    },
    onSuccess: (result) => {
      invalidate();
      setCreated(result);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not create that key'),
  });

  function close() {
    onOpenChange(false);
    // Reset after the close animation so the form does not visibly blank out
    // underneath the fading overlay.
    setTimeout(() => {
      setName('');
      setKind('personal');
      setScope(WHOLE_WORKSPACE);
      setExpiry(NEVER_EXPIRES);
      setCreated(null);
    }, 200);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        {created ? (
          <CreatedKeyBody created={created} onDone={close} />
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>Create an API key</ModalTitle>
              <ModalDescription>
                A key lets the Kortix CLI, a script, or a CI job work with this workspace without
                signing in.
              </ModalDescription>
            </ModalHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || mutation.isPending) return;
                mutation.mutate();
              }}
            >
              <ModalBody className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Deploy from GitHub"
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">So you can recognise it later.</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="api-key-kind">Who uses it</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => setKind(value as ApiKeyKind)}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="api-key-kind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">You and your own tools</SelectItem>
                      <SelectItem value="automation">An automation</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    {kind === 'personal'
                      ? 'Acts as you, so it can do what you can do. Sign in to the CLI with it right away.'
                      : 'Acts on its own, with permissions you grant it. Keeps working after you leave the team.'}
                  </p>
                </div>

                {kind === 'personal' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="api-key-scope">What it can reach</Label>
                    <Select value={scope} onValueChange={setScope} disabled={mutation.isPending}>
                      <SelectTrigger id="api-key-scope" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={WHOLE_WORKSPACE}>
                          Everything in this workspace
                        </SelectItem>
                        {projects.length > 0 ? (
                          <SelectGroup>
                            <SelectLabel>One project only</SelectLabel>
                            {projects.map((project) => (
                              <SelectItem key={project.project_id} value={project.project_id}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ) : null}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      Picking one project is safer: the key is turned away everywhere else.
                    </p>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor="api-key-expiry">Expires</Label>
                  <Select
                    value={selectedExpiry}
                    onValueChange={setExpiry}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="api-key-expiry" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {expiryChoices.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {policy?.require_expiry ? (
                    <p className="text-muted-foreground text-xs">
                      This workspace asks every key to have an end date.
                    </p>
                  ) : null}
                </div>
              </ModalBody>
              <ModalFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="outline-ghost"
                  size="sm"
                  onClick={close}
                  disabled={mutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!name.trim() || mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  Create key
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** The one and only sighting of the secret. */
function CreatedKeyBody({
  created,
  onDone,
}: {
  created: { name: string; secret: string };
  onDone: () => void;
}) {
  const { copy } = useCopy({ successMessage: 'Key copied' });
  return (
    <>
      <ModalHeader>
        <ModalTitle>Copy your key now</ModalTitle>
        <ModalDescription>
          This is the only time <strong>{created.name}</strong> is shown. Save it somewhere safe —
          we can&apos;t show it again, and a lost key has to be replaced.
        </ModalDescription>
      </ModalHeader>
      <ModalBody>
        <div className="bg-muted/30 relative overflow-hidden rounded-md border">
          <p className="p-3 pr-11 font-mono text-xs break-all">{created.secret}</p>
          <div className="absolute top-1.5 right-1.5">
            <CopyButton code={created.secret} />
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button type="button" variant="outline-ghost" size="sm" onClick={onDone}>
          Done
        </Button>
        <Button type="button" size="sm" className="gap-1.5" onClick={() => copy(created.secret)}>
          <CopyIcon className="size-3.5 shrink-0" />
          Copy key
        </Button>
      </ModalFooter>
    </>
  );
}

export interface ApiKeysSectionProps {
  accountId: string;
  canManage: boolean;
}

/**
 * List + heading + create action in one self-contained block, for callers that
 * have no pane header to hang the button on (the legacy account page). The
 * settings tab composes the same pieces itself so the action can sit in the
 * pane header instead.
 */
export function ApiKeysSection({ accountId, canManage }: ApiKeysSectionProps) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title="API keys"
        description="Let the Kortix CLI, a script, or a CI job work with this workspace."
        action={
          canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              Create key
            </Button>
          ) : undefined
        }
      />
      <ApiKeysList accountId={accountId} canManage={canManage} />
      <CreateApiKeyDialog accountId={accountId} open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}
