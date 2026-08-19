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

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  NEVER_EXPIRES,
  defaultExpiryOption,
  expiresAtIso,
  expiryOptions,
} from '@/components/iam/api-key-expiry';
import {
  type ApiKeyRow,
  type ApiKeyStatus,
  buildApiKeyRows,
} from '@/components/iam/api-key-rows';
import { MFA_REQUIRED_EVENT } from '@/features/auth/mfa-step-up';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CopyRow, type KebabItem } from '@/features/workspace/shared/access';
import { AccessList, AccessRow } from '@/features/workspace/shared/access';
import { getPatPolicy } from '@/lib/iam-client';
import { relativeTime } from '@/lib/relative-time';
import { usePermission } from '@/lib/use-permission';
import {
  createAccountToken,
  listAccountTokens,
  listProjectsForAccount,
  revokeAccountToken,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import { SettingsTabHeader } from '../settings-tab-header';

/** Sentinel Select value for "not scoped to one project". */
const WHOLE_WORKSPACE = '__workspace__';

/**
 * Query key for the caller's own keys. Deliberately NOT
 * `['account-tokens', accountId]` — that key holds the account-wide list the
 * token detail page reads, and two different reads of the same route under one
 * key would serve each other's rows.
 */
const MY_TOKENS_KEY = (accountId: string) => ['account-tokens', accountId, 'mine'];

/**
 * How each state reads on a row. Same three states, same colours, and the same
 * reasoning as the account hub's list: `revoked` is muted because someone chose
 * it; only `expired` — the state nobody chose, and the one that silently stops
 * a script — takes a warning colour.
 */
const STATUS_BADGE: Record<ApiKeyStatus, { label: string; variant: 'success' | 'update' | 'muted' }> =
  {
    active: { label: 'Active', variant: 'success' },
    expired: { label: 'Expired', variant: 'update' },
    revoked: { label: 'Revoked', variant: 'muted' },
  };

/** The account can demand a second factor before any key is readable. */
function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'account_mfa_required';
}

/**
 * The meta line under a key's name: what it looks like, when it was last used,
 * and when it stops working. Pure so the wording is testable without a DOM.
 */
export function apiKeyMetaParts(row: ApiKeyRow, now: number = Date.now()): string[] {
  const parts = [row.hint];
  if (row.scopeLabel) parts.push(row.scopeLabel);
  parts.push(row.lastUsedAt ? `Last used ${relativeTime(row.lastUsedAt)}` : 'Never used');
  if (row.expiresAt) {
    const ms = new Date(row.expiresAt).getTime();
    if (Number.isFinite(ms)) {
      parts.push(ms <= now ? `Expired ${relativeTime(row.expiresAt)}` : `Expires ${relativeTime(row.expiresAt)}`);
    }
  } else {
    parts.push('Never expires');
  }
  return parts;
}

export function TokensTab({ accountId }: { accountId: string | undefined }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const queryClient = useQueryClient();

  // `token.create` / `token.revoke` are admin leaves today
  // (`apps/api/src/iam/role-perms.ts` — `ADMIN_EXTRAS`), so a plain member of
  // someone else's account can READ their keys here but not mint one. This tab
  // reports that instead of offering a button the API answers 403 to; whether
  // minting your own key should be a member-level right is an IAM decision,
  // not this pane's to make.
  const canCreate = usePermission(accountId, 'token.create').allowed === true;
  const canRevoke = usePermission(accountId, 'token.revoke').allowed === true;

  const tokensQuery = useQuery({
    queryKey: MY_TOKENS_KEY(accountId ?? ''),
    queryFn: () => listAccountTokens(accountId, { mine: true }),
    enabled: !!accountId,
    staleTime: 30_000,
  });

  // Names only — a project-scoped key shows the project it is limited to
  // rather than a raw uuid.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId ?? ''),
    queryFn: () => listProjectsForAccount(accountId!),
    enabled: !!accountId,
    ...contract('inventory'),
  });

  const revokeMutation = useMutation({
    mutationFn: (row: ApiKeyRow) => revokeAccountToken(row.id, accountId),
    onSuccess: () => {
      successToast('Key revoked');
      queryClient.invalidateQueries({ queryKey: MY_TOKENS_KEY(accountId ?? '') });
      setRevokeTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not revoke that key'),
  });

  const rows = buildApiKeyRows({
    tokens: tokensQuery.data,
    projects: projectsQuery.data,
  });

  return (
    // `max-w-2xl` — the form tier every person-scoped pane in this dialog
    // uses (`tab-content-width.test.ts`). The rows are `AccessRow`s, not a
    // table, so nothing here needs the wide tier.
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <SettingsTabHeader
        tab="tokens"
        action={
          canCreate && rows.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              New key
            </Button>
          ) : undefined
        }
      />

      {!accountId ? (
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
            This workspace asks for a second factor before showing its keys. The list refreshes on
            its own once you have verified.
          </InfoBanner>
        ) : (
          <ErrorState
            size="sm"
            title="Couldn't load your keys"
            description={
              tokensQuery.error instanceof Error ? tokensQuery.error.message : undefined
            }
            action={
              <Button variant="outline" size="sm" onClick={() => tokensQuery.refetch()}>
                Retry
              </Button>
            }
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={KeyIcon}
          size="sm"
          title="No API keys yet"
          description={
            canCreate
              ? 'An API key signs the Kortix CLI, a script, or a CI job in as you — no browser, no password.'
              : 'An API key signs the Kortix CLI in as you. An admin of this workspace has to grant you permission to create one.'
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
                New key
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AccessList>
          {rows.map((row) => {
            // A revoked or expired key has nothing left to revoke — it is a
            // record now. There is no delete: the row is the audit trail.
            const kebab: KebabItem[] =
              canRevoke && row.status === 'active'
                ? [
                    {
                      label: 'Revoke key',
                      icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                      variant: 'destructive',
                      onSelect: () => setRevokeTarget(row),
                    },
                  ]
                : [];
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
                metaParts={apiKeyMetaParts(row)}
                kebab={kebab}
                kebabLabel={`Actions for ${row.name}`}
                pending={revokeMutation.isPending && revokeTarget?.id === row.id}
              />
            );
          })}
        </AccessList>
      )}

      {/* Where the OTHER kind of key lives. One line, because a person who
          came here for a CI credential has to be able to find it without
          reading the account hub's whole rail. */}
      <p className="text-muted-foreground text-xs">
        Keys for an automation that outlives you are service account tokens, in your{' '}
        {accountId ? (
          // A plain link, not `Button asChild`: a button is `inline-flex` with
          // its own height and padding, which breaks the sentence onto three
          // lines and strands the full stop on its own.
          <Link
            href={`/accounts/${accountId}?tab=tokens`}
            className="text-foreground underline underline-offset-2"
          >
            account settings
          </Link>
        ) : (
          'account settings'
        )}
        .
      </p>

      {accountId ? (
        <CreateApiKeyDialog
          accountId={accountId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() =>
            queryClient.invalidateQueries({ queryKey: MY_TOKENS_KEY(accountId) })
          }
        />
      ) : null}

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke this key?"
        description={
          revokeTarget
            ? `"${revokeTarget.name}" stops working right away. Anything still using it — the CLI, a script, a CI job — starts getting turned away. This can't be undone.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget);
        }}
      />
    </div>
  );
}

/**
 * Create, then show the secret once.
 *
 * Both halves live in one Modal on purpose: the secret is the only reason a
 * person opened this, and a dialog that closes and reopens somewhere else is
 * how a one-time secret gets lost.
 */
function CreateApiKeyDialog({
  accountId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(WHOLE_WORKSPACE);
  const [expiry, setExpiry] = useState<string>(NEVER_EXPIRES);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  // Both queries are dialog-scoped: nothing fetches until someone opens the form.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
    enabled: open,
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
  const expiryChoices = expiryOptions(policy);
  // The policy lands after first paint and can remove the option currently
  // selected ("Never", once expiry is required). Re-point at a legal value
  // rather than submitting one the backend will reject.
  const selectedExpiry = expiryChoices.some((o) => o.value === expiry)
    ? expiry
    : defaultExpiryOption(policy);

  const mutation = useMutation({
    mutationFn: async () => {
      const expiresAt = expiresAtIso(selectedExpiry);
      const token = await createAccountToken({
        name: name.trim(),
        accountId,
        ...(expiresAt ? { expiresAt } : {}),
        ...(scope === WHOLE_WORKSPACE ? {} : { projectId: scope }),
      });
      return { name: token.name, secret: token.secret_key };
    },
    onSuccess: (result) => {
      onCreated();
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
          <>
            <ModalHeader>
              <ModalTitle>Copy your key now</ModalTitle>
              <ModalDescription>
                This is the only time <strong>{created.name}</strong> is shown. Save it somewhere
                safe — we can&apos;t show it again, and a lost key has to be replaced.
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow value={created.secret} successMessage="Key copied" />
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
              <ModalTitle>Create an API key</ModalTitle>
              <ModalDescription>
                A key signs the Kortix CLI, a script, or a CI job in as you — it can do what you
                can do, and it stops working when you leave this workspace.
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
                  <Label htmlFor="personal-api-key-name">Name</Label>
                  <Input
                    id="personal-api-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="My laptop"
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">So you can recognise it later.</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="personal-api-key-scope">What it can reach</Label>
                  <Select value={scope} onValueChange={setScope} disabled={mutation.isPending}>
                    <SelectTrigger id="personal-api-key-scope" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={WHOLE_WORKSPACE}>Everything in this workspace</SelectItem>
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

                <div className="space-y-1.5">
                  <Label htmlFor="personal-api-key-expiry">Expires</Label>
                  <Select
                    value={selectedExpiry}
                    onValueChange={setExpiry}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="personal-api-key-expiry" className="w-full">
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
