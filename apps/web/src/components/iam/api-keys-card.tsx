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
 */

import { useState } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
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
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
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
import { CopyIcon, KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { NEVER_EXPIRES, defaultExpiryOption, expiresAtIso, expiryOptions } from './api-key-expiry';
import {
  type ApiKeyKind,
  type ApiKeyRow,
  type ApiKeyStatus,
  buildApiKeyRows,
  countApiKeysByStatus,
  filterApiKeyRows,
} from './api-key-rows';

/**
 * The Linear-borderless table dialect, byte-identical to `members-tab.tsx`'s
 * own `TABLE_HEAD_CELL`/`TABLE_CELL`/`TABLE_DATE_CELL` (that file's comment
 * explains why the container is local markup while every cell primitive stays
 * shared: `@/components/ui/table`'s `Table` hard-codes `rounded-md border
 * bg-popover` with no escape hatch, and 20+ other surfaces depend on it).
 *
 * Duplicated rather than imported: those constants are module-private in a
 * file under active edit, and reaching into it would fight that work. Worth
 * lifting into `components/ui/table.tsx` as a `variant="plain"` once the
 * Members pane settles — two panes now share this dialect, which is the point
 * at which it stops being one screen's taste.
 */
const TABLE_HEAD_CELL = 'text-muted-foreground px-3 py-1.5 text-xs first:pl-0 last:pr-0';
const TABLE_CELL = 'px-3 py-2.5 first:pl-0 last:pr-0';
const TABLE_DATE_CELL = 'text-muted-foreground tabular-nums';

/** Sentinel Select value for "not scoped to one project". */
const WHOLE_WORKSPACE = '__workspace__';

/** Sentinel for the "don't filter on this axis" option in both filters. */
const ANY = 'all';

const STATUS_FILTERS: { value: ApiKeyStatus | typeof ANY; label: string }[] = [
  { value: ANY, label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
];

const KIND_FILTERS: { value: ApiKeyKind | typeof ANY; label: string }[] = [
  { value: ANY, label: 'All types' },
  { value: 'personal', label: 'Personal' },
  { value: 'automation', label: 'Automation' },
];

/** How each state reads in the Status column. Tonal, not decorative: only a
 *  key that still works gets full-strength text plus the brand green dot. */
const STATUS_LABEL: Record<ApiKeyStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

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
  const [status, setStatus] = useState<ApiKeyStatus | typeof ANY>(ANY);
  const [kind, setKind] = useState<ApiKeyKind | typeof ANY>(ANY);

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
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
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

  // Counts are taken AFTER the kind filter and BEFORE the status filter, so
  // every number on the status bar is a count of rows that filter would
  // actually show.
  const inKindScope = filterApiKeyRows(rows, { kind });
  const counts = countApiKeysByStatus(inKindScope);
  const visible = filterApiKeyRows(inKindScope, { status, search });

  const busy = revokeMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search keys"
          aria-label="Search keys"
          className="h-8 w-full sm:max-w-64"
        />
        <div className="flex items-center gap-2">
          {/* The design system's filter/status control: `TabsListCompact` +
              `TabsTriggerCompact` under their own `Tabs` root, the same shape
              `review-center.tsx` and `changes-view.tsx` use. Radix owns
              `aria-selected` and roving focus, so the pills are keyboard
              navigable with the arrow keys for free. */}
          <Tabs
            value={status}
            onValueChange={(value) => setStatus(value as ApiKeyStatus | typeof ANY)}
          >
            <TabsListCompact>
              {STATUS_FILTERS.map((option) => (
                <TabsTriggerCompact key={option.value} value={option.value}>
                  {option.label}
                  {/* A count only when there is something to count — "Expired 0"
                      beside "Revoked 0" is two numbers saying nothing. Same rule
                      the Members tab bar and the review centre use. */}
                  {counts[option.value] > 0 ? (
                    <span className="ml-1 tabular-nums opacity-60">{counts[option.value]}</span>
                  ) : null}
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>
          <Select value={kind} onValueChange={(value) => setKind(value as ApiKeyKind | typeof ANY)}>
            <SelectTrigger size="sm" className="h-8 w-[136px]" aria-label="Filter by key type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          No keys match that. Try a different search, or set the filters back to All.
        </p>
      ) : (
        <div className="overflow-x-auto">
          {/* Local container, shared cells — see `TABLE_HEAD_CELL` above. */}
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="bg-transparent">
              <TableRow className="hover:bg-transparent">
                <TableHead className={TABLE_HEAD_CELL}>Key</TableHead>
                <TableHead className={TABLE_HEAD_CELL}>Type</TableHead>
                <TableHead className={TABLE_HEAD_CELL}>Status</TableHead>
                <TableHead className={TABLE_HEAD_CELL}>Created</TableHead>
                <TableHead className={TABLE_HEAD_CELL}>Last used</TableHead>
                <TableHead className={cn(TABLE_HEAD_CELL, 'text-right')}>
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
          </table>
        </div>
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
  return (
    <TableRow className="border-b-0 hover:bg-transparent">
      {/* Every cell is middle-aligned (the primitive's default). The old
          service-accounts table set `align-top`, so a two-line name cell left
          the badge and both dates floating at the top of the row — the
          "table is not aligned" report. The name cell is the only tall one;
          centring keeps the other four on one reading line. */}
      <TableCell className={cn(TABLE_CELL, 'max-w-[260px] whitespace-normal')}>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border',
              live ? 'bg-kortix-green/10 text-kortix-green' : 'text-muted-foreground',
            )}
          >
            <KeyIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'truncate font-medium',
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
            <p className="text-muted-foreground/70 truncate font-mono text-xs">{row.hint}</p>
          </div>
        </div>
      </TableCell>
      <TableCell className={cn(TABLE_CELL, 'text-muted-foreground text-xs')}>
        {row.kind === 'automation' ? 'Automation' : 'Personal'}
      </TableCell>
      <TableCell className={cn(TABLE_CELL, 'text-xs')}>
        <span className={cn('inline-flex items-center gap-1.5', !live && 'text-muted-foreground')}>
          {live ? <span className="bg-kortix-green size-1.5 shrink-0 rounded-full" /> : null}
          {STATUS_LABEL[row.status]}
        </span>
      </TableCell>
      <TableCell className={cn(TABLE_CELL, TABLE_DATE_CELL, 'text-xs')}>
        {relativeTime(row.createdAt)}
      </TableCell>
      <TableCell className={cn(TABLE_CELL, TABLE_DATE_CELL, 'text-xs')}>
        {row.lastUsedAt ? relativeTime(row.lastUsedAt) : 'Never'}
      </TableCell>
      <TableCell className={cn(TABLE_CELL, 'text-right')}>
        {busy ? (
          <Loading className="text-muted-foreground ml-auto" />
        ) : canManage ? (
          <>
            {live || row.status === 'expired' ? (
              <Button type="button" size="sm" variant="ghost" onClick={onRevoke}>
                Revoke
              </Button>
            ) : row.kind === 'automation' ? (
              // A revoked personal key has no delete endpoint — it stays as a
              // record. Only an automation key can be cleared from the list.
              <Button type="button" size="sm" variant="ghost" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
          </>
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
