'use client';

/**
 * Service account tokens: the account's machine identities.
 *
 * **What this used to be, and why it is half the size.** Until 2026-08-18 this
 * was "API keys" — ONE list merging two backends, personal access tokens
 * (`/accounts/tokens`) and service accounts
 * (`/accounts/{id}/iam/service-accounts`), on the theory that nobody arrives
 * at a credential screen thinking "do I want a PAT or a service account", they
 * arrive wanting a key. That was right about the vocabulary and wrong about
 * the place. Marko, 2026-08-18: "the personal tokens should be in the personal
 * settings and visible there. the automation tokens should be in the actual
 * account settings — organization/account level."
 *
 * The two kinds are not two implementations of one thing; they answer to
 * different people. A personal key acts as YOU, dies when your membership
 * does, and is nobody else's business — it belongs on your own settings page
 * (`features/workspace/settings/tabs/tokens-tab.tsx`, `/settings/tokens`). A
 * service account token acts as ITSELF, keeps working when its author leaves,
 * and is account configuration — it belongs here, beside the key rules that
 * govern it. So this file lists exactly one kind now, and the create form has
 * no "who uses it" question to ask.
 *
 * **Session tokens are listed nowhere.** The runtime mints one per sandbox and
 * revokes it on session delete (`mintConnectorToken` /
 * `revokeSessionConnectorTokens`). A person never creates one and cannot
 * usefully revoke one, so neither surface shows them — this one because it
 * reads service accounts, the personal one because the server filters them out
 * (`listPersonalAccountTokens`).
 *
 * **One layout, shared with every other access surface.** The rows are
 * `AccessList` / `AccessRow` from `features/workspace/shared/access` — the same
 * row the members, groups, projects and audit-webhook lists use. They were a
 * bordered `Table` here, borrowed from `secrets-view.tsx` when this list held
 * two backends' worth of columns; one kind of credential fits the row every
 * other list in this account already uses.
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { MFA_REQUIRED_EVENT } from '@/features/auth/mfa-step-up';
import { ErrorState } from '@/features/layout/section/error-state';
import { AccessList, AccessRow, CopyRow, type KebabItem } from '@/features/workspace/shared/access';
import {
  createServiceAccountApi,
  deleteServiceAccountApi,
  disableServiceAccountApi,
  getPatPolicy,
  listServiceAccountsApi,
} from '@/lib/iam-client';
import { relativeTime } from '@/lib/relative-time';
import { KeyIcon, MagnifyingGlassIcon, PlusIcon, ProhibitIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import { NEVER_EXPIRES, defaultExpiryOption, expiresAtIso, expiryOptions } from './api-key-expiry';
import {
  type ApiKeyFilterValue,
  type ApiKeyRow,
  type ApiKeyStatus,
  apiKeyFilter,
  buildApiKeyRows,
  countApiKeys,
  filterApiKeyRows,
} from './api-key-rows';

/**
 * How each state reads in the Status badge.
 *
 * `revoked` is `muted`, not `destructive`: someone chose to revoke it, and a
 * column of red would put the alarm on the wrong thing. Only `expired` — the
 * state nobody chose, and the one that silently stops a CI job — takes a
 * warning colour.
 */
const STATUS_BADGE: Record<ApiKeyStatus, { label: string; variant: 'success' | 'update' | 'muted' }> =
  {
    active: { label: 'Active', variant: 'success' },
    expired: { label: 'Expired', variant: 'update' },
    revoked: { label: 'Revoked', variant: 'muted' },
  };

const STATUS_OPTIONS: ApiKeyStatus[] = ['active', 'expired', 'revoked'];

/** The line under each filter option: what picking it leads to, before it is picked. */
function countLabel(count: number): string {
  if (count === 0) return 'None';
  return `${count} ${count === 1 ? 'token' : 'tokens'}`;
}

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

interface PendingAction {
  row: ApiKeyRow;
  action: 'revoke' | 'delete';
}

export interface ApiKeysListProps {
  accountId: string;
  /** `token.revoke` — hides every row action when false. */
  canManage: boolean;
}

/** The list itself. The create action is the caller's, so the pane header can own it. */
export function ApiKeysList({ accountId, canManage }: ApiKeysListProps) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SERVICE_ACCOUNTS_KEY(accountId) });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [search, setSearch] = useState('');
  /** One control, one axis — see `ApiKeyFilterValue` in `api-key-rows.ts`. */
  const [view, setView] = useState<ApiKeyFilterValue>('all');

  const serviceAccountsQuery = useQuery({
    queryKey: SERVICE_ACCOUNTS_KEY(accountId),
    queryFn: () => listServiceAccountsApi(accountId),
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    // "Revoke" to a reader, `disable` to the API: the row survives for the
    // audit trail and every request it makes is refused from here on.
    mutationFn: (row: ApiKeyRow) => disableServiceAccountApi(accountId, row.id),
    onSuccess: () => {
      successToast('Token revoked');
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not revoke that token'),
  });

  const deleteMutation = useMutation({
    mutationFn: (row: ApiKeyRow) => deleteServiceAccountApi(accountId, row.id),
    onSuccess: () => {
      successToast('Token deleted');
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not delete that token'),
  });

  if (serviceAccountsQuery.isLoading) {
    // Shape-matched to the toolbar plus a few rows, so the block does not
    // resize when data lands.
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 rounded-md" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-14 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  const error = serviceAccountsQuery.error;
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
          This workspace asks for a second factor before showing its tokens. The list refreshes on
          its own once you have verified.
        </InfoBanner>
      );
    }
    return (
      <ErrorState
        size="sm"
        title="Couldn't load these tokens"
        description={error instanceof Error ? error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => serviceAccountsQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const rows = buildApiKeyRows({ serviceAccounts: serviceAccountsQuery.data });

  // No tokens, no chrome — the toolbar goes with them: a search field over
  // nothing is furniture. The create action lives in the pane header where the
  // eye already lands (Jay, 2026-08-12: "If there is no service account yet,
  // don't show the empty state").
  if (rows.length === 0) return null;

  const counts = countApiKeys(rows);
  const visible = filterApiKeyRows(rows, { ...apiKeyFilter(view), search });
  const busy = revokeMutation.isPending || deleteMutation.isPending;

  // An option that leads to an empty list is not offered. The currently
  // selected one always survives, or revoking the last active token would make
  // the selection vanish out of the trigger while it was still in force.
  const statusOptions = STATUS_OPTIONS.filter((value) => counts[value] > 0 || view === value);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <InputGroupSearch className="min-w-0 sm:flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search tokens"
            aria-label="Search tokens"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setSearch('')} />
        </InputGroupSearch>

        {/* Status only. The filter used to carry a second axis — Personal vs
            Automation — which is not a question this list can answer any more:
            every row on it is an automation. */}
        <Select value={view} onValueChange={(value) => setView(value as ApiKeyFilterValue)}>
          <SelectTrigger className="w-full shrink-0 sm:w-44" aria-label="Filter tokens">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem size="sm" value="all" description={countLabel(counts.all)}>
              All tokens
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
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          {search.trim() ? (
            <>
              No tokens match <span className="text-foreground font-mono">{search.trim()}</span>.
            </>
          ) : (
            // Only reachable when the selection goes stale mid-session — revoke
            // the last active token while "Active" is showing.
            'Nothing left under this filter. Choose “All tokens” to see the rest.'
          )}
        </p>
      ) : (
        <AccessList>
          {visible.map((row) => {
            const live = row.status === 'active';
            const canRevoke = live || row.status === 'expired';
            const kebab: KebabItem[] = !canManage
              ? []
              : canRevoke
                ? [
                    {
                      label: 'Revoke token',
                      icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                      variant: 'destructive',
                      onSelect: () => setPending({ row, action: 'revoke' }),
                    },
                  ]
                : [
                    {
                      label: 'Delete token',
                      icon: <TrashIcon className="size-3.5 shrink-0" />,
                      variant: 'destructive',
                      onSelect: () => setPending({ row, action: 'delete' }),
                    },
                  ];
            return (
              <AccessRow
                key={row.id}
                leading={<EntityAvatar icon={KeyIcon} label={row.name} size="sm" />}
                title={row.name}
                badges={
                  <Badge variant={STATUS_BADGE[row.status].variant} size="sm">
                    {STATUS_BADGE[row.status].label}
                  </Badge>
                }
                metaParts={[
                  row.hint,
                  `Created ${relativeTime(row.createdAt)}`,
                  row.lastUsedAt ? `Last used ${relativeTime(row.lastUsedAt)}` : 'Never used',
                  row.expiresAt ? `Expires ${relativeTime(row.expiresAt)}` : 'Never expires',
                ]}
                kebab={kebab}
                kebabLabel={`Actions for ${row.name}`}
                pending={busy && pending?.row.id === row.id}
              />
            );
          })}
        </AccessList>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.action === 'delete' ? 'Delete this token?' : 'Revoke this token?'}
        description={
          pending
            ? pending.action === 'delete'
              ? `Removes "${pending.row.name}" from this list for good, along with anything it was allowed to do.`
              : `"${pending.row.name}" stops working right away. Anything still using it — a script, a CI job — starts getting turned away. This can't be undone.`
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
 *
 * The form lost two fields when the personal keys left. "Who uses it" had one
 * answer here now, and the project scope picker only ever applied to the other
 * kind — a service account is an account-level identity whose reach comes from
 * the policies attached to it, not from a binding chosen at mint time.
 */
export function CreateApiKeyDialog({ accountId, open, onOpenChange }: CreateApiKeyDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<string>(NEVER_EXPIRES);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

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
      const sa = await createServiceAccountApi(accountId, {
        name: name.trim(),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
      return { name: sa.name, secret: sa.secret };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: SERVICE_ACCOUNTS_KEY(accountId) });
      setCreated(result);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not create that token'),
  });

  function close() {
    onOpenChange(false);
    // Reset after the close animation so the form does not visibly blank out
    // underneath the fading overlay.
    setTimeout(() => {
      setName('');
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
          <>
            <ModalHeader>
              <ModalTitle>Copy this token now</ModalTitle>
              <ModalDescription>
                This is the only time <strong>{created.name}</strong>&apos;s token is shown. Save it
                somewhere safe — we can&apos;t show it again, and a lost token has to be replaced.
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow value={created.secret} successMessage="Token copied" />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                Done
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>Create a service account token</ModalTitle>
              <ModalDescription>
                A service account is an identity of its own — it acts with the permissions you
                grant it, and it keeps working after the person who made it leaves.
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
                  <Label htmlFor="service-account-name">Name</Label>
                  <Input
                    id="service-account-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Deploy from GitHub"
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    Name it after the job it does, so an audit line reads as itself.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="service-account-expiry">Expires</Label>
                  <Select
                    value={selectedExpiry}
                    onValueChange={setExpiry}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="service-account-expiry" className="w-full">
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
                  Create token
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

export interface ApiKeysSectionProps {
  accountId: string;
  canManage: boolean;
}

/**
 * List + heading + create action, plus the one line that says where the OTHER
 * kind of key lives. That line is not decoration: this pane is where everyone
 * has looked for an API key for months, and a person who lands here for a CLI
 * key has to be able to leave with one.
 */
export function ApiKeysSection({ accountId, canManage }: ApiKeysSectionProps) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title="Service account tokens"
        description="Identities for CI, scripts, and integrations — they act on their own, not as a person."
        action={
          canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              New token
            </Button>
          ) : undefined
        }
      />
      {/* `ApiKeysList` renders NOTHING when there are no tokens — no icon, no
          headline, no second Create button. Jay, 2026-08-12: "If there is no
          service account yet, don't show the empty state." The create action
          lives in the header above, where the eye already lands. */}
      <ApiKeysList accountId={accountId} canManage={canManage} />
      <p className="text-muted-foreground text-xs">
        Your own API keys — the ones that sign the CLI in as you — live in your{' '}
        <Link href="/settings/tokens" className="text-foreground underline underline-offset-2">
          settings → API keys
        </Link>
        .
      </p>
      <CreateApiKeyDialog accountId={accountId} open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}
