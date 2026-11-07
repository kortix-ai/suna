'use client';

/**
 * API keys — the keys YOU minted, on the page that is about you.
 *
 * **Why this tab exists.** Three kinds of credential live in one table
 * (`account_tokens`) and they were all listed on one screen, the account hub's
 * Tokens tab: a person's own API key, a service account's bearer, and the
 * connector token the runtime mints per sandbox. Marko, 2026-08-18: "the
 * personal tokens should be in the personal settings and visible there. the
 * automation tokens should be in the actual account settings — organization /
 * account level. The session token we don't care about." So they split by who
 * the credential belongs to, not by which table it is stored in:
 *
 *   - **Here** — API keys. One person's, acting as that person. Every member
 *     has this tab; nobody sees anyone else's keys on it.
 *   - **`/accounts/<id>` › Tokens** — service account tokens. An automation's
 *     own identity, which outlives whoever created it, plus the key rules that
 *     govern expiry. An account-configuration surface, admin-gated as before.
 *   - **Nowhere** — session tokens. The runtime mints and revokes them itself
 *     (`mintConnectorToken` / `revokeSessionConnectorTokens`); a person never
 *     creates one and cannot usefully revoke one.
 *
 * **Scope: the active account, not every account.** `GET /accounts/tokens` is
 * account-scoped — it resolves ONE account from `?account_id=` or the caller's
 * default (`resolveAccountForUser`) — so this lists the keys you hold in the
 * account you are currently in, the same account every other pane in this
 * dialog configures (`useSettingsAccountId`). A cross-account read would need
 * a new route; nothing in the product needs one yet.
 *
 * **The narrowing is server-side and has to be.** `?mine=true` maps to
 * `listPersonalAccountTokens` (`apps/api/src/repositories/account-tokens.ts`),
 * which filters on `user_id`, `session_id`, `service_account_id` and
 * `agent_grant`. The list payload carries none of those columns, so a browser
 * cannot do this filtering — the old surface guessed at the session tokens
 * with `name.startsWith('Connector Session ')` and could not separate one
 * member's keys from another's at all.
 */

import { type ReactNode, useRef, useState } from 'react';

import {
  defaultKeyExpiryOption,
  keyExpiresAt,
  keyExpiryOptions,
} from '../../../access/iam/api-key-expiry';
import { type ApiKeyRow, type ApiKeyStatus, buildApiKeyRows } from '../../../access/iam/api-key-rows';
import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Checkbox } from '../../../primitives/checkbox';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast, successToast } from '../../../primitives/toast';
import { HubLink } from '../../../internal/account-hub/account-hub-location';
import { MFA_REQUIRED_EVENT } from '../../../internal/auth/mfa-pending-action';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { CopyRow, type KebabItem } from '../../../access/access';
import { RowKebab } from '../../../access/access/access-row';
import { useLocale, useTranslations } from '../../../i18n';
import { getPatPolicy } from '@kortix/sdk';
import { relativeTime } from '../../../internal/lib/relative-time';
import { usePermission } from '../../../internal/lib/use-permission';
import { hubTarget } from '../../../internal/stores/account-panel-store';
import {
  createAccountToken,
  createWorkspaceToken,
  listAccountTokens,
  listPersonalTokens,
  listProjectsForAccount,
  listPermissions,
  listWorkspaceTokens,
  revokeAccountToken,
  revokePersonalToken,
  revokeWorkspaceToken,
  type AccountToken,
  type Permission,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon, ProhibitIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SettingsTabHeader } from '../settings-tab-header';
import { SettingsSubsectionHeader } from '../../../primitives/settings-subsection-header';
import { ConnectedApps } from './connected-apps';

/** Sentinel Select value for "not scoped to one project". */
const WHOLE_WORKSPACE = '__workspace__';

/**
 * Query key for the caller's own keys. Deliberately NOT
 * `['account-tokens', accountId]` — that key holds the account-wide list the
 * token detail page reads, and two different reads of the same route under one
 * key would serve each other's rows.
 */
const MY_TOKENS_KEY = (accountId: string) => ['account-tokens', accountId, 'mine'];
/** The caller's personal keys (`GET /v1/me/tokens`). */
const PERSONAL_TOKENS_KEY = ['me-tokens'];

/**
 * How each state reads on a row. Same three states, same colours, and the same
 * reasoning as the account hub's list: `revoked` is muted because someone chose
 * it; only `expired` — the state nobody chose, and the one that silently stops
 * a script — takes a warning colour.
 */
const STATUS_BADGE: Record<ApiKeyStatus, { variant: 'success' | 'update' | 'muted' }> = {
  active: { variant: 'success' },
  expired: { variant: 'update' },
  revoked: { variant: 'muted' },
};

/** The account can demand a second factor before any key is readable. */
function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'account_mfa_required';
}

/**
 * The meta line under a key's name: what it looks like, when it was last used,
 * and when it stops working. Pure so the wording is testable without a DOM.
 */
export interface ApiKeyMetaCopy {
  neverUsed: string;
  neverExpires: string;
  /** The access label of a key row (`Full access`, `Read only`, `Custom · 3`); null hides it. */
  access?: (row: ApiKeyRow) => string | null;
  /** Shown instead of the expiry for a key whose expiry moves out on every use. */
  renewsOnUse?: string;
  lastUsed: (time: string) => string;
  expired: (time: string) => string;
  expires: (time: string) => string;
  relativeTime: (input: string | number) => string;
}

const DEFAULT_API_KEY_META_COPY: ApiKeyMetaCopy = {
  neverUsed: 'Never used',
  neverExpires: 'Never expires',
  lastUsed: (time) => `Last used ${time}`,
  expired: (time) => `Expired ${time}`,
  expires: (time) => `Expires ${time}`,
  relativeTime,
};

export function apiKeyMetaParts(
  row: ApiKeyRow,
  now: number = Date.now(),
  copy: ApiKeyMetaCopy = DEFAULT_API_KEY_META_COPY,
): string[] {
  const parts = [row.hint];
  if (row.scopeLabel) parts.push(row.scopeLabel);
  const access = copy.access?.(row);
  if (access) parts.push(access);
  parts.push(row.lastUsedAt ? copy.lastUsed(copy.relativeTime(row.lastUsedAt)) : copy.neverUsed);
  if (row.expiryRenews && copy.renewsOnUse && row.status === 'active') {
    parts.push(copy.renewsOnUse);
  } else if (row.expiresAt) {
    const ms = new Date(row.expiresAt).getTime();
    if (Number.isFinite(ms)) {
      const time = copy.relativeTime(row.expiresAt);
      parts.push(ms <= now ? copy.expired(time) : copy.expires(time));
    }
  } else {
    parts.push(copy.neverExpires);
  }
  return parts;
}

export function localizedRelativeTime(
  input: string | number,
  locale: string,
  now = Date.now(),
): string {
  return relativeTime(input, locale, now, { zero: 'minute' });
}

/**
 * Which keys the list shows (design.md §3.2 C4):
 *
 *  - `workspace`: Workspace settings › API keys. The caller's keys bound to
 *    this workspace (`/v1/workspaces/:id/tokens?mine=true`). A new key acts as
 *    the caller in this workspace only, so the scope reads "This workspace".
 *  - `personal`: Preferences › Personal keys. The caller's keys bound to no
 *    workspace (the CLI login, older account-wide keys): they act as the
 *    person in every workspace of theirs. They are listed and revoked here,
 *    never minted (`/v1/me/tokens`).
 *  - `account`: the older account-scoped list, for a host without a workspace.
 */
type KeyMode = 'workspace' | 'personal' | 'account';

export function TokensTab({
  accountId,
  workspaceId,
  embedded = false,
  personal = false,
}: {
  accountId: string | undefined;
  /** Set: list and mint keys bound to this workspace. */
  workspaceId?: string;
  /** Inside Workspace settings › API keys: a subsection under the page's own
   *  title, and no pointer to the service-account keys below it. */
  embedded?: boolean;
  /** Preferences › Personal keys: the caller's keys bound to no workspace. */
  personal?: boolean;
}) {
  const mode: KeyMode = personal ? 'personal' : workspaceId ? 'workspace' : 'account';
  const tWorkspaces = useTranslations('workspaces.settings');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.tokens');
  const locale = useLocale();
  const [mountAt] = useState(() => Date.now());
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    row: ApiKeyRow;
    action: 'revoke' | 'delete';
  } | null>(null);
  const [detailRow, setDetailRow] = useState<ApiKeyRow | null>(null);
  const queryClient = useQueryClient();
  const metaCopy: ApiKeyMetaCopy = {
    neverUsed: t('neverUsed'),
    neverExpires: t('neverExpires'),
    lastUsed: (time) => t('lastUsed', { time }),
    expired: (time) => t('expiredAt', { time }),
    expires: (time) => t('expiresAt', { time }),
    relativeTime: (input) => localizedRelativeTime(input, locale, renderedAt),
    access: (row) => accessLabel(row, tWorkspaces),
    renewsOnUse: tWorkspaces('keyExpiryRenews'),
  };

  // Every row here is the caller's OWN hand-minted key (`mine: true`), so the
  // gates are the personal leaves every system account role holds — a plain
  // member can mint and revoke their own keys. An account that denies
  // `token.personal.*` by policy gets the read-only view instead of a button
  // the API answers 403 to.
  // A personal key is the caller's own everywhere: no account policy gates
  // listing or revoking it, and it is never minted here.
  const canCreatePersonal = usePermission(accountId, 'token.personal.create').allowed === true;
  const canRevokePersonal = usePermission(accountId, 'token.personal.revoke').allowed === true;
  // The UI mints workspace keys only (design.md §3.2 C4a): a key acts in one
  // workspace. A personal key comes from `kortix login`; the older account
  // list (no workspace) lists and revokes, never mints.
  const canCreate = mode === 'workspace' && canCreatePersonal;
  const canRevoke = mode === 'personal' || canRevokePersonal;
  const listKey = mode === 'personal' ? PERSONAL_TOKENS_KEY : MY_TOKENS_KEY(workspaceId ?? accountId ?? '');

  const tokensQuery = useQuery<AccountToken[]>({
    queryKey: listKey,
    queryFn: () =>
      mode === 'personal'
        ? listPersonalTokens()
        : mode === 'workspace'
          ? listWorkspaceTokens(workspaceId!, { mine: true })
          : listAccountTokens(accountId, { mine: true }),
    enabled: mode === 'personal' || !!accountId,
    staleTime: 30_000,
  });

  // A stamp that lands after the pane mounted — a key used while this dialog
  // is open — must not be aged against the mount-time clock: the past/future
  // direction would flip and "Last used just now" would become a countdown
  // for something that already happened. So the clock is the query's own
  // fetch time once data has landed (it advances with every refetch), and the
  // mount capture only covers the first paint, keeping SSR and hydration
  // agreeing exactly as the plain `useState(() => Date.now())` did.
  const renderedAt = tokensQuery.dataUpdatedAt || mountAt;

  // Names only — a project-scoped key shows the project it is limited to
  // rather than a raw uuid.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId ?? ''),
    queryFn: () => listProjectsForAccount(accountId!),
    enabled: mode === 'account' && !!accountId,
    ...contract('inventory'),
  });

  const revokeMutation = useMutation({
    mutationFn: (row: ApiKeyRow) =>
      mode === 'personal'
        ? revokePersonalToken(row.id)
        : mode === 'workspace'
          ? revokeWorkspaceToken(workspaceId!, row.id)
          : revokeAccountToken(row.id, accountId),
    onSuccess: () => {
      successToast(t('keyRevoked'));
      queryClient.invalidateQueries({ queryKey: listKey });
      setConfirmTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || t('revokeFailed')),
  });

  // A revoked key cannot be revoked again — the API answers 404. The same
  // route with `?delete_revoked=true` removes the dead row instead, and the
  // API only ever honors it for the caller's OWN personal key
  // (`deleteRevokedPersonalAccountToken`), so the audit rows of other
  // members' keys, service accounts and session tokens stay untouchable.
  const deleteMutation = useMutation({
    mutationFn: (row: ApiKeyRow) =>
      mode === 'workspace'
        ? revokeWorkspaceToken(workspaceId!, row.id, { deleteRevoked: true })
        : revokeAccountToken(row.id, accountId, { deleteRevoked: true }),
    onSuccess: () => {
      successToast(t('keyDeleted'));
      queryClient.invalidateQueries({ queryKey: listKey });
      setDetailRow(null);
      setConfirmTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || t('deleteFailed')),
  });

  // A workspace key acts on this workspace only; a personal key acts as the
  // person in every workspace of theirs. The row says which, never "Whole workspace".
  const scopeLabel =
    mode === 'workspace' ? tWorkspaces('keyScopeWorkspace') : mode === 'personal' ? tWorkspaces('keyScopePersonal') : undefined;
  const rows = buildApiKeyRows({
    tokens: tokensQuery.data,
    projects: projectsQuery.data,
  }).map((row) => (scopeLabel ? { ...row, scopeLabel } : row));

  return (
    // `max-w-2xl` — the form tier every person-scoped pane in this dialog
    // uses (`tab-content-width.test.ts`). The list is one card of flat rows, not a
    // table, so nothing here needs the wide tier.
    <div className="mx-auto w-full max-w-2xl space-y-5">
      {mode === 'personal' ? (
        <SettingsTabHeader tab="personal-keys" />
      ) : embedded ? (
        <SettingsSubsectionHeader title={tWorkspaces('personalKeysTitle')} description={tWorkspaces('personalKeysDescription')} />
      ) : (
        <SettingsTabHeader tab="tokens" hideDescription />
      )}

      {mode !== 'personal' && !accountId ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-md" />
          <Skeleton className="h-14 rounded-md" />
        </div>
      ) : tokensQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-md" />
          <Skeleton className="h-14 rounded-md" />
        </div>
      ) : tokensQuery.isError ? (
        isMfaRequired(tokensQuery.error) ? (
          <InfoBanner
            tone="warning"
            title={t('confirmIdentity')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT))}
              >
                {t('verify')}
              </Button>
            }
          >
            {t('mfaDescription')}
          </InfoBanner>
        ) : (
          <ErrorState
            size="sm"
            title={t('loadFailed')}
            description={tokensQuery.error instanceof Error ? tokensQuery.error.message : undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => tokensQuery.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={KeyIcon}
          size="sm"
          title={t('emptyTitle')}
          description={
            mode === 'personal' ? tWorkspaces('personalKeysEmpty') : canCreate ? t('emptyCanCreate') : t('emptyNoPermission')
          }
          action={
            canCreate ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon className="size-3.5 shrink-0" />
                {t('newKey')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        // Linear's API key list: one card, a header row with the count and
        // the create action, then flat rows separated by hairlines. A row
        // opens the key's details; its ⋯ keeps Revoke one click away.
        <div className="bg-surface overflow-hidden rounded-lg border">
          <div className="flex h-12 items-center justify-between gap-3 border-b pr-2 pl-4">
            <span className="text-foreground text-sm font-medium">
              {t('keyCount', { count: rows.length })}
            </span>
            {canCreate ? (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon className="size-3.5 shrink-0" />
                {t('newKey')}
              </Button>
            ) : null}
          </div>
          <ul className="divide-y">
            {rows.map((row) => {
              // An active key's ⋯ revokes it. A revoked key has nothing left
              // to revoke — its ⋯ deletes it: the API keeps revoked rows as
              // history, but a person cleaning up after themselves (or the
              // account-cleanup journey) needs the row gone, and the delete
              // only ever reaches their OWN dead key (KRTX-2656). An expired
              // key stays a record: nothing chose to revoke it, and the API
              // deletes revoked rows only.
              const kebab: KebabItem[] =
                canRevoke && row.status === 'active'
                  ? [
                      {
                        label: t('revokeKey'),
                        icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                        variant: 'destructive',
                        onSelect: () => setConfirmTarget({ row, action: 'revoke' }),
                      },
                    ]
                  : canRevoke && row.status === 'revoked' && mode !== 'personal'
                    ? [
                        {
                          label: t('deleteKey'),
                          icon: <TrashIcon className="size-3.5 shrink-0" />,
                          variant: 'destructive',
                          onSelect: () => setConfirmTarget({ row, action: 'delete' }),
                        },
                      ]
                    : [];
              const meta = [
                t('createdOn', { date: formatShortDate(row.createdAt, locale) }),
                ...apiKeyMetaParts(row, renderedAt, metaCopy).slice(1),
              ];
              return (
                <li
                  key={row.id}
                  className="hover:bg-hover relative flex items-center gap-3 px-4 py-3"
                >
                  {/* The whole row opens the details; the ⋯ sits above it. */}
                  <button
                    type="button"
                    aria-label={row.name}
                    className="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
                    onClick={() => setDetailRow(row)}
                  />
                  <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                    <KeyIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {row.name}
                      </span>
                      {row.status !== 'active' ? (
                        <Badge variant={STATUS_BADGE[row.status].variant} size="sm">
                          {t(`status.${row.status}`)}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {meta.join(' · ')}
                    </span>
                  </span>
                  {kebab.length > 0 ? (
                    <span className="relative z-10 shrink-0">
                      <RowKebab items={kebab} label={t('actionsFor', { name: row.name })} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Where the OTHER kind of key lives. One line, because a person who
          came here for a CI credential has to be able to find it without
          reading the account hub's whole rail. */}
      {embedded || mode === 'personal' ? null : (
      <p className="text-muted-foreground text-xs">
        {t.rich('serviceAccountTokens', {
          link: (chunks) =>
            accountId ? (
              <HubLink
                to={hubTarget(accountId, { tab: 'tokens' })}
                className="text-foreground underline underline-offset-2"
              >
                {chunks}
              </HubLink>
            ) : (
              <>{chunks}</>
            ),
        })}
      </p>
      )}

      {/* Apps you signed in to with Kortix act as you: the person's own list. */}
      {mode === 'workspace' ? null : (
        <ConnectedApps relativeTime={(iso) => localizedRelativeTime(iso, locale, renderedAt)} />
      )}

      {accountId && mode !== 'personal' ? (
        <CreateApiKeyDialog
          accountId={accountId}
          workspaceId={mode === 'workspace' ? workspaceId : undefined}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => queryClient.invalidateQueries({ queryKey: listKey })}
        />
      ) : null}

      <ApiKeyDetailModal
        row={detailRow}
        locale={locale}
        metaCopy={metaCopy}
        canRevoke={canRevoke}
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
        onConfirm={(row, action) => {
          setDetailRow(null);
          setConfirmTarget({ row, action });
        }}
      />

      <ConfirmDialog
        open={!!confirmTarget}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={
          confirmTarget?.action === 'delete' ? t('deleteTitle') : t('revokeTitle')
        }
        description={
          confirmTarget
            ? confirmTarget.action === 'delete'
              ? t('deleteDescription', { name: confirmTarget.row.name })
              : t('revokeDescription', { name: confirmTarget.row.name })
            : ''
        }
        confirmLabel={confirmTarget?.action === 'delete' ? t('deleteKey') : t('revoke')}
        confirmVariant="destructive"
        isPending={revokeMutation.isPending || deleteMutation.isPending}
        onConfirm={() => {
          if (!confirmTarget) return;
          if (confirmTarget.action === 'delete') deleteMutation.mutate(confirmTarget.row);
          else revokeMutation.mutate(confirmTarget.row);
        }}
      />
    </div>
  );
}

export function formatShortDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function formatLongDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * One key's details, Linear's layout in a modal: the name as the title, the
 * creation date under it, the ⋯ on the right, then one card of labelled rows.
 * Read-only: a key's name, scope and expiry are fixed at creation.
 */
function ApiKeyDetailModal({
  row,
  locale,
  metaCopy,
  canRevoke,
  onOpenChange,
  onConfirm,
}: {
  row: ApiKeyRow | null;
  locale: string;
  metaCopy: ApiKeyMetaCopy;
  canRevoke: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (row: ApiKeyRow, action: 'revoke' | 'delete') => void;
}) {
  const t = useTranslations('settings.tokens');
  const tWorkspaces = useTranslations('workspaces.settings');
  const fields: Array<{ label: string; value: ReactNode }> = row
    ? [
        { label: t('keyName'), value: row.name },
        { label: t('keyPrefix'), value: <span className="font-mono">{row.hint}</span> },
        { label: t('scope'), value: row.scopeLabel ?? t('wholeWorkspace') },
        ...(row.access
          ? [{ label: tWorkspaces('keyAccess'), value: accessLabel(row, tWorkspaces) ?? tWorkspaces('keyAccessFull') }]
          : []),
        ...(row.permissions && row.permissions.length > 0
          ? [
              {
                label: tWorkspaces('keyPermissions'),
                value: (
                  <span className="flex flex-col gap-0.5 font-mono text-xs">
                    {row.permissions.map((permission) => (
                      <span key={permission}>{permission}</span>
                    ))}
                  </span>
                ),
              },
            ]
          : []),
        {
          label: t('statusLabel'),
          value: (
            <Badge variant={STATUS_BADGE[row.status].variant} size="sm">
              {t(`status.${row.status}`)}
            </Badge>
          ),
        },
        {
          label: t('lastUsedLabel'),
          value: row.lastUsedAt ? metaCopy.relativeTime(row.lastUsedAt) : metaCopy.neverUsed,
        },
        {
          label: t('expires'),
          value: row.expiresAt
            ? row.expiryRenews && metaCopy.renewsOnUse
              ? `${formatLongDate(row.expiresAt, locale)} · ${metaCopy.renewsOnUse}`
              : formatLongDate(row.expiresAt, locale)
            : metaCopy.neverExpires,
        },
      ]
    : [];
  return (
    <Modal open={!!row} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-lg">
        {row ? (
          <>
            <ModalHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <ModalTitle className="truncate">{row.name}</ModalTitle>
                  <ModalDescription>
                    {t('createdOn', { date: formatLongDate(row.createdAt, locale) })}
                  </ModalDescription>
                </div>
                {canRevoke && (row.status === 'active' || row.status === 'revoked') ? (
                  <RowKebab
                    label={t('actionsFor', { name: row.name })}
                    items={
                      row.status === 'active'
                        ? [
                            {
                              label: t('revokeKey'),
                              icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                              variant: 'destructive',
                              onSelect: () => onConfirm(row, 'revoke'),
                            },
                          ]
                        : [
                            {
                              label: t('deleteKey'),
                              icon: <TrashIcon className="size-3.5 shrink-0" />,
                              variant: 'destructive',
                              onSelect: () => onConfirm(row, 'delete'),
                            },
                          ]
                    }
                  />
                ) : null}
              </div>
            </ModalHeader>
            <ModalBody>
              <dl className="divide-y rounded-lg border">
                {fields.map((field) => (
                  <div key={field.label} className="space-y-1 px-4 py-3">
                    <dt className="text-foreground text-sm font-medium">{field.label}</dt>
                    <dd className="text-muted-foreground text-sm">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </ModalBody>
          </>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * Create, then show the secret once.
 *
 * Both halves live in one Modal on purpose: the secret is the only reason a
 * person opened this, and a dialog that closes and reopens somewhere else is
 * how a one-time secret gets lost.
 */
export function CreateApiKeyDialog({
  accountId,
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  /** Set: mint a workspace key (`POST /v1/workspaces/:id/tokens`), which acts on this workspace only. */
  workspaceId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.tokens');
  const tWorkspaces = useTranslations('workspaces.settings');
  const common = useTranslations('common');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(WHOLE_WORKSPACE);
  const [expiry, setExpiry] = useState<string>('');
  const [access, setAccess] = useState<KeyAccess>('full');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  // The permission catalog, for a custom key only. The API refuses a permission
  // the creator's role lacks (`key_scope_exceeds_role`) and names it.
  const permissionsQuery = useQuery({
    queryKey: ['iam-permissions', workspaceId ?? accountId],
    queryFn: () => listPermissions(workspaceId ?? accountId),
    enabled: open && !!workspaceId && access === 'custom',
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Both queries are dialog-scoped: nothing fetches until someone opens the form.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
    enabled: open && !workspaceId,
  });
  const projects = projectsQuery.data ?? [];

  // The workspace's key rules. A plain member may not be able to read them
  // (`retry: false`, `?? null`) — the form then offers every expiry and the
  // API is the one that enforces, which is where enforcement belongs anyway.
  const policyQuery = useQuery({
    queryKey: ['iam-pat-policy', accountId],
    queryFn: () => getPatPolicy(accountId),
    staleTime: 30_000,
    enabled: open,
    retry: false,
  });
  const policy = policyQuery.data ?? null;
  // A key always expires (90 days preselected, 365 at most) unless the
  // workspace key policy allows no expiry (`allow_no_expiry`).
  const expiryChoices = keyExpiryOptions(policy, tI18nComplete).map((choice) => ({
    ...choice,
    label:
      Number.isNaN(Number(choice.value))
        ? t('expiryNever')
        : Number(choice.value) === 365
          ? t('expiryOneYear')
          : t('expiryDays', { count: Number(choice.value) }),
  }));
  // The policy lands after first paint and can remove the option currently
  // selected ("Never", once expiry is required). Re-point at a legal value
  // rather than submitting one the backend will reject.
  const selectedExpiry = expiryChoices.some((o) => o.value === expiry)
    ? expiry
    : defaultKeyExpiryOption(policy, tI18nComplete);
  const customEmpty = !!workspaceId && access === 'custom' && picked.size === 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const expiresAt = keyExpiresAt(selectedExpiry);
      if (workspaceId) {
        const token = await createWorkspaceToken(workspaceId, {
          name: name.trim(),
          expiresAt,
          scopes: access === 'custom' ? [...picked] : access,
        });
        return { name: token.name, secret: token.secret_key };
      }
      const token = await createAccountToken({
        name: name.trim(),
        accountId,
        expiresAt,
        ...(scope === WHOLE_WORKSPACE ? {} : { projectId: scope }),
      });
      return { name: token.name, secret: token.secret_key };
    },
    onSuccess: (result) => {
      onCreated();
      setCreated(result);
    },
    onError: (err: Error) => errorToast(err.message || t('createFailed')),
    // The synchronous half of the double-submit guard: the observer's
    // `isPending` is scheduled with setTimeout(0), so two submit events in
    // one tick both saw a fresh mutation and minted two keys (KRTX-2639).
    // A ref flips before the first request leaves and resets only when the
    // mutation settles, so a retry after a real failure still works.
    onSettled: () => {
      submitInFlight.current = false;
    },
  });
  const submitInFlight = useRef(false);

  function close() {
    onOpenChange(false);
    // Reset after the close animation so the form does not visibly blank out
    // underneath the fading overlay.
    setTimeout(() => {
      setName('');
      setScope(WHOLE_WORKSPACE);
      setExpiry('');
      setAccess('full');
      setPicked(new Set());
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
      <ModalContent className="lg:max-w-lg" closeLabel={common('close')}>
        {created ? (
          <>
            <ModalHeader>
              <ModalTitle>{t('copyNow')}</ModalTitle>
              <ModalDescription>
                {t.rich('copyDescription', {
                  name: created.name,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow value={created.secret} successMessage={t('keyCopied')} />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                {t('done')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>{t('createTitle')}</ModalTitle>
              <ModalDescription>{t('createDescription')}</ModalDescription>
            </ModalHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || customEmpty || mutation.isPending || submitInFlight.current) return;
                submitInFlight.current = true;
                mutation.mutate();
              }}
            >
              <ModalBody className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="personal-api-key-name">{t('name')}</Label>
                  <Input
                    id="personal-api-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('namePlaceholder')}
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">{t('nameHint')}</p>
                </div>

                {workspaceId ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-api-key-access">{tWorkspaces('keyAccess')}</Label>
                    <Select
                      value={access}
                      onValueChange={(value) => setAccess(value as KeyAccess)}
                      disabled={mutation.isPending}
                    >
                      <SelectTrigger id="workspace-api-key-access" size="md" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="full">{tWorkspaces('keyAccessFull')}</SelectItem>
                        <SelectItem value="read">{tWorkspaces('keyAccessRead')}</SelectItem>
                        <SelectItem value="custom">{tWorkspaces('keyAccessCustom')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      {tWorkspaces(
                        access === 'read'
                          ? 'keyAccessReadHint'
                          : access === 'custom'
                            ? 'keyAccessCustomHint'
                            : 'keyAccessFullHint',
                      )}{' '}
                      {tWorkspaces('keyScopeWorkspaceHint')}
                    </p>
                    {access === 'custom' ? (
                      <PermissionPicker
                        query={permissionsQuery}
                        picked={picked}
                        onToggle={(action, on) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(action);
                            else next.delete(action);
                            return next;
                          })
                        }
                        disabled={mutation.isPending}
                      />
                    ) : null}
                  </div>
                ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="personal-api-key-scope">{t('scope')}</Label>
                  <Select value={scope} onValueChange={setScope} disabled={mutation.isPending}>
                    <SelectTrigger id="personal-api-key-scope" size="md" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={WHOLE_WORKSPACE}>{t('wholeWorkspace')}</SelectItem>
                      {projects.length > 0 ? (
                        <SelectGroup>
                          <SelectLabel>{t('oneProject')}</SelectLabel>
                          {projects.map((project) => (
                            <SelectItem key={project.project_id} value={project.project_id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ) : null}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">{t('scopeHint')}</p>
                </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="personal-api-key-expiry">{t('expires')}</Label>
                  <Select
                    value={selectedExpiry}
                    onValueChange={setExpiry}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="personal-api-key-expiry" size="md" className="w-full">
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
                    <p className="text-muted-foreground text-xs">{t('expiryRequired')}</p>
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
                  {t('cancel')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!name.trim() || customEmpty || mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {t('createKey')}
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** What a new workspace key may do inside its creator's role. */
type KeyAccess = 'full' | 'read' | 'custom';

/** The access label of a key row; null for a row without one (a service account). */
function accessLabel(row: ApiKeyRow, tWorkspaces: ReturnType<typeof useTranslations>): string | null {
  if (!row.access) return null;
  if (row.access === 'read') return tWorkspaces('keyAccessRead');
  if (row.access === 'custom') return tWorkspaces('keyAccessCustomCount', { count: row.permissions?.length ?? 0 });
  return tWorkspaces('keyAccessFull');
}

/**
 * The permissions of a custom key: the catalog grouped by area, one checkbox
 * per permission, the workspace name in mono. Only what the creator's role
 * holds can be minted; the API names any other.
 */
export function PermissionPicker({
  query,
  picked,
  onToggle,
  disabled,
}: {
  query: { data?: Permission[]; isLoading: boolean; isError: boolean; refetch: () => unknown };
  picked: ReadonlySet<string>;
  onToggle: (action: string, on: boolean) => void;
  disabled: boolean;
}) {
  const tWorkspaces = useTranslations('workspaces.settings');
  if (query.isLoading) {
    return (
      <div className="space-y-1">
        <Skeleton className="h-7 rounded-md" />
        <Skeleton className="h-7 rounded-md" />
        <Skeleton className="h-7 rounded-md" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        size="sm"
        title={tWorkspaces('keyPermissionsLoadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            {tWorkspaces('keyPermissionsRetry')}
          </Button>
        }
      />
    );
  }
  const byArea = new Map<string, Permission[]>();
  for (const permission of query.data) {
    const list = byArea.get(permission.area) ?? [];
    list.push(permission);
    byArea.set(permission.area, list);
  }
  return (
    <div className="bg-popover max-h-64 space-y-4 overflow-y-auto rounded-md border px-4 py-3">
      {[...byArea.entries()].map(([area, permissions]) => (
        <div key={area} className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium">{area}</p>
          {permissions.map((permission) => {
            const action = workspacePermissionName(permission);
            return (
              <Checkbox
                key={permission.action}
                id={`key-permission-${permission.action}`}
                checked={picked.has(action)}
                disabled={disabled}
                onCheckedChange={(state) => onToggle(action, state === true)}
                label={
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground text-sm">{permission.description || action}</span>
                    <span className="text-muted-foreground font-mono text-xs">{action}</span>
                  </span>
                }
              />
            );
          })}
        </div>
      ))}
      {picked.size === 0 ? (
        <p className="text-muted-foreground text-xs">{tWorkspaces('keyAccessPickOne')}</p>
      ) : null}
    </div>
  );
}

/** The workspace spelling of a catalog row (`workspace_action`), else its stored name. */
function workspacePermissionName(permission: Permission): string {
  return (permission as Permission & { workspace_action?: string }).workspace_action ?? permission.action;
}
