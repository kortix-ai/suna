'use client';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
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
import {
  KeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
} from '@phosphor-icons/react';
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
const STATUS_BADGE: Record<
  ApiKeyStatus,
  { label: string; variant: 'success' | 'update' | 'muted' }
> = {
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const statusBadges = useLocalizedUiCatalog(STATUS_BADGE);
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
      successToast(tI18nComplete.raw('text775f96fcc9db'));
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textfe4666578c32')),
  });

  const deleteMutation = useMutation({
    mutationFn: (row: ApiKeyRow) => deleteServiceAccountApi(accountId, row.id),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text126b835f55e1'));
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text3a42e3a0cc79')),
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
          title={tI18nComplete.raw('text6176eec272e8')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT))}
            >
              {tI18nComplete.raw('texteea2745e2867')}
            </Button>
          }
        >
          {tI18nComplete.raw('text534e356b9a09')}
        </InfoBanner>
      );
    }
    return (
      <ErrorState
        size="sm"
        title={tI18nComplete.raw('text72f493e2adcc')}
        description={error instanceof Error ? error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => serviceAccountsQuery.refetch()}>
            {tI18nComplete.raw('text942087cc2d41')}
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
            placeholder={tI18nComplete.raw('text1b5465e03357')}
            aria-label={tI18nComplete.raw('text1b5465e03357')}
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
          <SelectTrigger
            className="w-full shrink-0 sm:w-44"
            aria-label={tI18nComplete.raw('text47cb1961551f')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem size="sm" value="all" description={countLabel(counts.all)}>
              {tI18nComplete.raw('text229c8c14416e')}
            </SelectItem>
            {statusOptions.length > 0 ? (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{tI18nComplete.raw('text920e413c7d41')}</SelectLabel>
                  {statusOptions.map((value) => (
                    <SelectItem
                      size="sm"
                      key={value}
                      value={value}
                      description={countLabel(counts[value])}
                    >
                      {statusBadges[value].label}
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
              {tI18nComplete.raw('textdd730b855f7f')}{' '}
              <span className="text-foreground font-mono">{search.trim()}</span>.
            </>
          ) : (
            // Only reachable when the selection goes stale mid-session — revoke
            // the last active token while "Active" is showing.
            tI18nComplete.raw('text4058739857b7')
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
                      label: tI18nComplete.raw('text14683b379324'),
                      icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                      variant: 'destructive',
                      onSelect: () => setPending({ row, action: 'revoke' }),
                    },
                  ]
                : [
                    {
                      label: tI18nComplete.raw('text8cb21e2a5846'),
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
                  <Badge variant={statusBadges[row.status].variant} size="sm">
                    {statusBadges[row.status].label}
                  </Badge>
                }
                metaParts={[
                  row.hint,
                  `Created ${relativeTime(row.createdAt)}`,
                  row.lastUsedAt
                    ? `Last used ${relativeTime(row.lastUsedAt)}`
                    : tI18nComplete.raw('text24d3236c3ac4'),
                  row.expiresAt
                    ? `Expires ${relativeTime(row.expiresAt)}`
                    : tI18nComplete.raw('text6a9894204cc7'),
                ]}
                kebab={kebab}
                kebabLabel={tI18nComplete('text33da220b1a34', { value0: row.name })}
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
        title={
          pending?.action === 'delete'
            ? tI18nComplete.raw('text26ecc76c0ce9')
            : tI18nComplete.raw('text33271bd27f08')
        }
        description={
          pending
            ? pending.action === 'delete'
              ? tI18nComplete('textb3fd52fda8e3', { value0: pending.row.name })
              : tI18nComplete('textca226cefdb63', { value0: pending.row.name })
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  const expiryChoices = expiryOptions(policy, tI18nComplete);
  // The policy lands after first paint, and it can remove the option currently
  // selected ("Never", once expiry is required). Re-point at a legal value
  // rather than submitting one the backend will reject.
  const selectedExpiry = expiryChoices.some((o) => o.value === expiry)
    ? expiry
    : defaultExpiryOption(policy, tI18nComplete);

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
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textc85c6ea416c8')),
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
              <ModalTitle>{tI18nComplete.raw('textd7db5a6e1483')}</ModalTitle>
              <ModalDescription>
                {tI18nComplete.raw('textd21d10509292')} <strong>{created.name}</strong>
                {tI18nComplete.raw('text26a69b6ee645')}
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow
                value={created.secret}
                successMessage={tI18nComplete.raw('textc9feac7acc32')}
              />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                {tI18nComplete.raw('text11a6767d5674')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>{tI18nComplete.raw('text44d5cf8e9451')}</ModalTitle>
              <ModalDescription>{tI18nComplete.raw('text7074515e8fda')}</ModalDescription>
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
                  <Label htmlFor="service-account-name">
                    {tI18nComplete.raw('textdcd1d5223f73')}
                  </Label>
                  <Input
                    id="service-account-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={tI18nComplete.raw('textc725967d3988')}
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    {tI18nComplete.raw('textb74399647bf0')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="service-account-expiry">
                    {tI18nComplete.raw('textf6725f3af08a')}
                  </Label>
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
                      {tI18nComplete.raw('texta06efd337206')}
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
                  {tI18nComplete.raw('text19766ed6ccb2')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!name.trim() || mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tI18nComplete.raw('text5d8e8e30bc4f')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={tI18nComplete.raw('textaff66989659f')}
        description={tI18nComplete.raw('textce5979e3cee6')}
        action={
          canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              {tI18nComplete.raw('textfe46cb83ad1c')}
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
        {tI18nComplete.raw('text4703d3bef6c4')}{' '}
        <Link href="/settings/tokens" className="text-foreground underline underline-offset-2">
          {tI18nComplete.raw('text80b9316cb15b')}
        </Link>
        .
      </p>
      <CreateApiKeyDialog accountId={accountId} open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}
