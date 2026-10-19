'use client';

import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
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
 * **Layout: a flat, Linear-style table** (`iam-table.tsx`) — Name, Created,
 * Last used, Expires — Jay's pick from the Paper "API · service account tokens"
 * variants (2026-10-13: 01 empty, 03 table). Status is a dot before the name;
 * the row kebab is `AccessRow`'s own (`RowKebab`), so the menu reads the same
 * as every other access list.
 */

import { type FormEvent, type ReactNode, useState } from 'react';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { MFA_REQUIRED_EVENT } from '@/features/auth/mfa-step-up';
import { ErrorState } from '@kortix/ui/error-state';
import { useAccountHubSheet } from '@kortix/ui/internal/account-hub/hub-sheet';
import { CopyRow, RowKebab, type KebabItem } from '@kortix/ui/access/access/index';
import { cn } from '@kortix/ui';
import {
  createServiceAccountApi,
  deleteServiceAccountApi,
  disableServiceAccountApi,
  getPatPolicy,
  listServiceAccountsApi,
} from '@/lib/iam-client';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import {
  KeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import { NEVER_EXPIRES, defaultExpiryOption, expiresAtIso, expiryOptions } from '@kortix/ui/access/iam/api-key-expiry';
import { IamTable, IamTableCell, IamTableHead, IamTableRow } from './iam-table';
import {
  type ApiKeyFilterValue,
  type ApiKeyRow,
  type ApiKeyStatus,
  apiKeyFilter,
  buildApiKeyRows,
  countApiKeys,
  filterApiKeyRows,
} from '@kortix/ui/access/iam/api-key-rows';

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

/** The status dot before each name: green live, orange expired, an empty ring revoked. */
const STATUS_DOT: Record<ApiKeyStatus, string> = {
  active: 'bg-kortix-green',
  expired: 'bg-kortix-orange',
  revoked: 'border-muted-foreground/50 border',
};

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
  /** One line under the list — inside the empty block when there are no tokens. */
  footnote?: ReactNode;
}

/** The list itself. The create action is the caller's, so the pane header can own it. */
export function ApiKeysList({ accountId, canManage, footnote }: ApiKeysListProps) {
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

  // No tokens: one quiet empty block, no toolbar — a search field over nothing
  // is furniture. The create action stays in the section header (Paper
  // "API · service account tokens", variant 01, Jay's pick 2026-10-13).
  if (rows.length === 0) {
    return (
      <div className="border-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-6 py-12 text-center">
        <KeyIcon className="text-muted-foreground mb-1 size-5" />
        <p className="text-foreground text-sm font-medium">{tI18nComplete.raw('text79eb7fb19229')}</p>
        <p className="text-muted-foreground text-sm">{tI18nComplete.raw('texta56abb72ba43')}</p>
        {/* Where the OTHER kind of key lives: inside the block while it is empty. */}
        {footnote ? <div className="mt-3">{footnote}</div> : null}
      </div>
    );
  }

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
        <IamTable label={tI18nComplete.raw('textaff66989659f')}>
          <IamTableHead>
            <IamTableCell header>{tI18nComplete.raw('textdcd1d5223f73')}</IamTableCell>
            <IamTableCell header width="w-24">{tI18nComplete.raw('textd70b9e24bca2')}</IamTableCell>
            <IamTableCell header width="w-24">{tI18nComplete.raw('text830ec7f812f9')}</IamTableCell>
            <IamTableCell header width="w-24">{tI18nComplete.raw('textf6725f3af08a')}</IamTableCell>
            <IamTableCell width="w-7" />
          </IamTableHead>
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
            const rowBusy = busy && pending?.row.id === row.id;
            return (
              <IamTableRow key={row.id} muted={!live}>
                <IamTableCell>
                  {/* Status as a dot, its name for screen readers: a column of
                      badges was louder than the names it sat beside. */}
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[row.status])}
                  />
                  <span className="sr-only">{statusBadges[row.status].label}</span>
                  <span
                    className={cn(
                      'truncate',
                      live && 'font-medium',
                      row.status === 'revoked' && 'line-through',
                    )}
                  >
                    {row.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-xs">
                    {row.hint}
                  </span>
                </IamTableCell>
                <IamTableCell width="w-24" className="text-muted-foreground">
                  {relativeTime(row.createdAt)}
                </IamTableCell>
                <IamTableCell width="w-24" className="text-muted-foreground">
                  {row.lastUsedAt
                    ? relativeTime(row.lastUsedAt)
                    : tI18nComplete.raw('text6300ef800bb8')}
                </IamTableCell>
                <IamTableCell
                  width="w-24"
                  className={row.status === 'expired' ? 'text-kortix-orange' : 'text-muted-foreground'}
                >
                  {row.status === 'revoked'
                    ? statusBadges.revoked.label
                    : row.status === 'expired'
                      ? statusBadges.expired.label
                      : row.expiresAt
                        ? relativeTime(row.expiresAt)
                        : tI18nComplete.raw('text6300ef800bb8')}
                </IamTableCell>
                <IamTableCell width="w-7" align="end">
                  {rowBusy ? (
                    <Loading className="size-3.5" />
                  ) : kebab.length > 0 ? (
                    <RowKebab
                      items={kebab}
                      label={tI18nComplete('text33da220b1a34', { value0: row.name })}
                    />
                  ) : null}
                </IamTableCell>
              </IamTableRow>
            );
          })}
        </IamTable>
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
      {footnote}
    </div>
  );
}

export interface CreateApiKeyDialogProps {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The create form's state: name, expiry under the account's key rules, and
 * the one-time secret once the token exists. Shared by the modal (personal
 * settings) and the account hub's split sheet, so both mint the same way.
 *
 * `onCreated` runs from the mutation's own options, not from a `mutate`
 * callback: it still fires if the form unmounted mid-request (the sheet was
 * closed), so the one-time secret is never dropped.
 */
/** Lets the sheet's pinned footer read the create request's state: it renders outside the form. */
const CREATE_SERVICE_ACCOUNT_KEY = (accountId: string) => ['create-service-account', accountId];
const CREATE_TOKEN_FORM_ID = 'create-service-account-form';

function useCreateApiKey(
  accountId: string,
  enabled: boolean,
  onCreated?: (created: { name: string; secret: string }) => void,
) {
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
    enabled,
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
    mutationKey: CREATE_SERVICE_ACCOUNT_KEY(accountId),
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
      onCreated?.(result);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textc85c6ea416c8')),
  });

  function reset() {
    setName('');
    setExpiry(NEVER_EXPIRES);
    setCreated(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  return { name, setName, setExpiry, selectedExpiry, expiryChoices, policy, created, mutation, reset, submit };
}

type CreateApiKeyState = ReturnType<typeof useCreateApiKey>;

/** Name and expiry: the two fields both containers render. */
function CreateApiKeyFields({ form }: { form: CreateApiKeyState }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pending = form.mutation.isPending;
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="service-account-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
        <Input
          id="service-account-name"
          value={form.name}
          onChange={(event) => form.setName(event.target.value)}
          placeholder={tI18nComplete.raw('textc725967d3988')}
          disabled={pending}
          maxLength={128}
          required
          autoFocus
          variant="popover"
        />
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textb74399647bf0')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="service-account-expiry">{tI18nComplete.raw('textf6725f3af08a')}</Label>
        <Select value={form.selectedExpiry} onValueChange={form.setExpiry} disabled={pending}>
          <SelectTrigger id="service-account-expiry" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {form.expiryChoices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {form.policy?.require_expiry ? (
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('texta06efd337206')}</p>
        ) : null}
      </div>
    </>
  );
}

/**
 * Create, then show the secret once, in a modal. The personal settings page
 * (`tokens-tab.tsx`) mounts this one; the account hub opens
 * `CreateApiKeySheetForm` in its split sheet instead.
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
  const form = useCreateApiKey(accountId, open);
  const pending = form.mutation.isPending;

  function close() {
    onOpenChange(false);
    // Reset after the close animation so the form does not visibly blank out
    // underneath the fading overlay.
    setTimeout(form.reset, 200);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        {form.created ? (
          <>
            <ModalHeader>
              <ModalTitle>{tI18nComplete.raw('textd7db5a6e1483')}</ModalTitle>
              <ModalDescription>
                {tI18nComplete.raw('textd21d10509292')} <strong>{form.created.name}</strong>
                {tI18nComplete.raw('text26a69b6ee645')}
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow
                value={form.created.secret}
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
            <form onSubmit={form.submit}>
              <ModalBody className="space-y-4">
                <CreateApiKeyFields form={form} />
              </ModalBody>
              <ModalFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="outline-ghost"
                  size="sm"
                  onClick={close}
                  disabled={pending}
                >
                  {tI18nComplete.raw('text19766ed6ccb2')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!form.name.trim() || pending}
                  className="gap-1.5"
                >
                  {pending ? <Loading className="size-3.5 shrink-0" /> : null}
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

/**
 * The create form as the body of the account hub's split sheet: the fields
 * only. Its buttons are `CreateApiKeySheetFooter`, pinned in the sheet's
 * footer and tied to this form by `form=` id. On success the sheet is
 * re-opened with the secret — from the mutation's own options, so a sheet
 * closed mid-request still reopens with the one-time secret.
 */
function CreateApiKeySheetForm({ accountId }: { accountId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const sheet = useAccountHubSheet();
  const form = useCreateApiKey(accountId, true, (created) =>
    sheet.open({
      title: tI18nComplete.raw('textd7db5a6e1483'),
      description: (
        <>
          {tI18nComplete.raw('textd21d10509292')} <strong>{created.name}</strong>
          {tI18nComplete.raw('text26a69b6ee645')}
        </>
      ),
      body: <CopyRow value={created.secret} successMessage={tI18nComplete.raw('textc9feac7acc32')} />,
      footer: (
        <Button type="button" size="sm" onClick={sheet.close}>
          {tI18nComplete.raw('text11a6767d5674')}
        </Button>
      ),
    }),
  );

  return (
    <form id={CREATE_TOKEN_FORM_ID} onSubmit={form.submit} className="space-y-4">
      <CreateApiKeyFields form={form} />
    </form>
  );
}

/** Cancel and Create, pinned at the sheet's bottom. Reads the request's state by mutation key. */
function CreateApiKeySheetFooter({ accountId }: { accountId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const sheet = useAccountHubSheet();
  const pending = useIsMutating({ mutationKey: CREATE_SERVICE_ACCOUNT_KEY(accountId) }) > 0;
  return (
    // Cancel on the left edge, the commit action on the right.
    <div className="flex w-full items-center justify-between gap-2">
      <Button type="button" variant="outline-ghost" size="sm" onClick={sheet.close} disabled={pending}>
        {tI18nComplete.raw('text19766ed6ccb2')}
      </Button>
      <Button type="submit" form={CREATE_TOKEN_FORM_ID} size="sm" disabled={pending} className="gap-1.5">
        {pending ? <Loading className="size-3.5 shrink-0" /> : null}
        {tI18nComplete.raw('text5d8e8e30bc4f')}
      </Button>
    </div>
  );
}

/** Where a person's own API key lives (Settings → Tokens). */
function ApiKeyFootnote() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <p className="text-muted-foreground text-xs">
      {tI18nComplete.raw('text4703d3bef6c4')}{' '}
      <Link href="/settings/tokens" className="text-foreground underline underline-offset-2">
        {tI18nComplete.raw('text80b9316cb15b')}
      </Link>
      .
    </p>
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
 *
 * "New token" opens the form in the account hub's split sheet, beside the list.
 */
export function ApiKeysSection({ accountId, canManage }: ApiKeysSectionProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const sheet = useAccountHubSheet();

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
              onClick={() =>
                sheet.open({
                  title: tI18nComplete.raw('text44d5cf8e9451'),
                  description: tI18nComplete.raw('text7074515e8fda'),
                  body: <CreateApiKeySheetForm accountId={accountId} />,
                  footer: <CreateApiKeySheetFooter accountId={accountId} />,
                })
              }
            >
              <PlusIcon className="size-4 shrink-0" />
              {tI18nComplete.raw('textfe46cb83ad1c')}
            </Button>
          ) : undefined
        }
      />
      <ApiKeysList accountId={accountId} canManage={canManage} footnote={<ApiKeyFootnote />} />
    </section>
  );
}
