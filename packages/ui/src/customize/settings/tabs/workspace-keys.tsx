'use client';

/**
 * Workspace settings › API keys: ONE list of every key of the workspace, and
 * ONE create that asks who the key acts as (design.md §3.2 C4b).
 *
 *   - You: your role in this workspace; revoked when you leave.
 *   - An agent: a kortix.yaml agent's own identity, exactly its grant inside
 *     its role; audited as the agent; it survives its creator leaving.
 *   - A bot: a machine identity for CI or an integration, with its own roles.
 *
 * Every member sees and manages their own keys. Agent and bot keys need
 * `token.create` (`can_manage_principals` on the list). This replaced the two
 * lists "Your keys for this workspace" and "Service account tokens".
 */

import { useRef, useState, type ReactNode } from 'react';

import {
  createWorkspaceKey,
  getPatPolicy,
  listPermissions,
  listWorkspaceKeys,
  revokeWorkspaceKey,
  type CreatedWorkspaceKey,
  type WorkspaceKey,
  type WorkspaceKeyList,
  type WorkspaceKeyPrincipal,
} from '@kortix/sdk';
import { KeyIcon, PlusIcon, ProhibitIcon, RobotIcon, TerminalWindowIcon, TrashIcon, UserIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { defaultKeyExpiryOption, keyExpiresAt, keyExpiryOptions } from '../../../access/iam/api-key-expiry';
import {
  NEW_BOT,
  actsAsInput,
  actsAsOptions,
  keyRowAction,
  keyStatus,
  sortKeys,
  type ActsAsDraft,
} from '../../../access/iam/workspace-key-acts-as';
import { CopyRow, type KebabItem } from '../../../access/access';
import { RowKebab } from '../../../access/access/access-row';
import { useLocale, useTranslations } from '../../../i18n';
import { MFA_REQUIRED_EVENT } from '../../../internal/auth/mfa-pending-action';
import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import Loading from '../../../primitives/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../../primitives/modal';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../../../primitives/select';
import { SettingsSubsectionHeader } from '../../../primitives/settings-subsection-header';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast, successToast } from '../../../primitives/toast';
import { PermissionPicker, formatShortDate, localizedRelativeTime } from './tokens-tab';

const KEYS_QUERY = (workspaceId: string) => ['workspace-keys', workspaceId];

const STATUS_BADGE = { active: 'success', expired: 'update', revoked: 'muted' } as const;

const ACTS_AS_ICON: Record<WorkspaceKeyPrincipal, typeof KeyIcon> = { me: UserIcon, agent: RobotIcon, bot: TerminalWindowIcon };

type KeyAccess = 'full' | 'read' | 'custom';

function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'account_mfa_required';
}

/** "You", "Agent · reporter" or "Bot · ci". */
function useActsAsLabel() {
  const t = useTranslations('workspaces.settings.keys');
  return (actsAs: WorkspaceKey['acts_as']) =>
    actsAs.type === 'me'
      ? t('rowYou')
      : actsAs.type === 'agent'
        ? t('rowAgent', { name: actsAs.name ?? '' })
        : t('rowBot', { name: actsAs.name ?? '' });
}

export function WorkspaceKeysSection({
  workspaceId,
  accountId,
  heading = true,
}: {
  workspaceId: string;
  accountId: string;
  /** False inside a pane that already shows the title: "New key" moves into the list's header row. */
  heading?: boolean;
}) {
  const t = useTranslations('workspaces.settings.keys');
  const tTokens = useTranslations('settings.tokens');
  const tWorkspaces = useTranslations('workspaces.settings');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const actsAsLabel = useActsAsLabel();
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<{ key: WorkspaceKey; action: 'revoke' | 'delete' } | null>(null);
  const [mountAt] = useState(() => Date.now());

  const keysQuery = useQuery<WorkspaceKeyList>({
    queryKey: KEYS_QUERY(workspaceId),
    queryFn: () => listWorkspaceKeys(workspaceId),
    staleTime: 30_000,
  });
  const now = keysQuery.dataUpdatedAt || mountAt;
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEYS_QUERY(workspaceId) });

  const revoke = useMutation({
    mutationFn: ({ key, action }: { key: WorkspaceKey; action: 'revoke' | 'delete' }) =>
      revokeWorkspaceKey(workspaceId, key.key_id, { deleteRevoked: action === 'delete' }),
    onSuccess: (_result, { action }) => {
      successToast(action === 'delete' ? tTokens('keyDeleted') : tTokens('keyRevoked'));
      refresh();
      setPending(null);
    },
    onError: (err: Error, { action }) => errorToast(err.message || (action === 'delete' ? tTokens('deleteFailed') : tTokens('revokeFailed'))),
  });

  const list = keysQuery.data;
  const keys = sortKeys(list?.keys ?? [], now);
  const accessLabel = (key: WorkspaceKey) =>
    key.scope === 'read'
      ? tWorkspaces('keyAccessRead')
      : key.scope === 'custom'
        ? tWorkspaces('keyAccessCustomCount', { count: key.workspace_permissions?.length ?? 0 })
        : tWorkspaces('keyAccessFull');
  const relative = (iso: string) => localizedRelativeTime(iso, locale, now);

  const newKeyButton = (variant: 'secondary' | 'outline' | 'ghost') => (
    <Button size="sm" variant={variant} className="gap-1.5" onClick={() => setCreateOpen(true)}>
      <PlusIcon className="size-3.5 shrink-0" />
      {t('newKey')}
    </Button>
  );

  let body: ReactNode;
  if (keysQuery.isLoading) {
    body = (
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    );
  } else if (keysQuery.isError) {
    body = isMfaRequired(keysQuery.error) ? (
      <InfoBanner
        tone="warning"
        title={tTokens('confirmIdentity')}
        action={
          <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT))}>
            {tTokens('verify')}
          </Button>
        }
      >
        {tTokens('mfaDescription')}
      </InfoBanner>
    ) : (
      <ErrorState
        size="sm"
        title={tTokens('loadFailed')}
        description={keysQuery.error instanceof Error ? keysQuery.error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => keysQuery.refetch()}>
            {tTokens('retry')}
          </Button>
        }
      />
    );
  } else if (keys.length === 0) {
    body = <EmptyState icon={KeyIcon} size="sm" title={t('emptyTitle')} description={t('emptyDescription')} action={newKeyButton('outline')} />;
  } else {
    body = (
      // One card of flat rows, the key list's established layout.
      <div className="bg-surface overflow-hidden rounded-lg border">
        <div className="flex h-12 items-center justify-between gap-3 border-b pr-2 pl-4">
          <span className="text-foreground text-sm font-medium">{t('count', { count: keys.length })}</span>
          {heading ? null : newKeyButton('ghost')}
        </div>
        <ul className="divide-y" aria-label={t('title')}>
          {keys.map((key) => {
            const status = keyStatus(key, now);
            const action = keyRowAction(key, list?.can_manage_principals === true, now);
            const Icon = ACTS_AS_ICON[key.acts_as.type];
            const kebab: KebabItem[] = action
              ? [
                  {
                    label: action === 'revoke' ? tTokens('revokeKey') : tTokens('deleteKey'),
                    icon: action === 'revoke' ? <ProhibitIcon className="size-3.5 shrink-0" /> : <TrashIcon className="size-3.5 shrink-0" />,
                    variant: 'destructive',
                    onSelect: () => setPending({ key, action }),
                  },
                ]
              : [];
            const meta = [
              accessLabel(key),
              key.last_used_at ? tTokens('lastUsed', { time: relative(key.last_used_at) }) : tTokens('neverUsed'),
              status === 'revoked'
                ? tTokens('status.revoked')
                : key.expires_at
                  ? status === 'expired'
                    ? tTokens('expiredAt', { time: relative(key.expires_at) })
                    : tTokens('expiresAt', { time: relative(key.expires_at) })
                  : tTokens('neverExpires'),
              key.acts_as.type !== 'me' && key.created_by_email
                ? t('createdBy', { email: key.created_by_email })
                : tTokens('createdOn', { date: formatShortDate(key.created_at, locale) }),
            ];
            return (
              <li key={key.key_id} className="flex items-center gap-3 px-4 py-3" data-acts-as={key.acts_as.type}>
                <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">{key.name}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">{actsAsLabel(key.acts_as)}</span>
                    {status !== 'active' ? (
                      <Badge variant={STATUS_BADGE[status]} size="sm">
                        {tTokens(`status.${status}`)}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    <span className="font-mono">{key.public_key}</span> · {meta.join(' · ')}
                  </span>
                </span>
                {kebab.length > 0 ? <RowKebab items={kebab} label={tTokens('actionsFor', { name: key.name })} /> : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-2xl space-y-4">
      {heading ? <SettingsSubsectionHeader title={t('title')} description={t('description')} action={newKeyButton('secondary')} /> : null}
      {body}
      <CreateWorkspaceKeyDialog
        workspaceId={workspaceId}
        accountId={accountId}
        list={list ?? null}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refresh}
      />
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.action === 'delete' ? tTokens('deleteTitle') : tTokens('revokeTitle')}
        description={
          pending
            ? pending.action === 'delete'
              ? tTokens('deleteDescription', { name: pending.key.name })
              : tTokens('revokeDescription', { name: pending.key.name })
            : ''
        }
        confirmLabel={pending?.action === 'delete' ? tTokens('deleteKey') : tTokens('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (pending) revoke.mutate(pending);
        }}
      />
    </section>
  );
}

/** Create, then show the secret once, in one modal (a one-time secret is never lost to a reopen). */
function CreateWorkspaceKeyDialog({
  workspaceId,
  accountId,
  list,
  open,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  accountId: string;
  list: WorkspaceKeyList | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('workspaces.settings.keys');
  const tTokens = useTranslations('settings.tokens');
  const tWorkspaces = useTranslations('workspaces.settings');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const common = useTranslations('common');
  const actsAsLabel = useActsAsLabel();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ActsAsDraft>({ actsAs: 'me', agent: '', bot: '', newBotName: '' });
  const [access, setAccess] = useState<KeyAccess>('full');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [expiry, setExpiry] = useState('');
  const [created, setCreated] = useState<CreatedWorkspaceKey | null>(null);
  const submitInFlight = useRef(false);

  const options = actsAsOptions(list);
  const blockLabel = (block: ReturnType<typeof actsAsOptions>[number]['block']) =>
    block === 'needs_permission' ? t('needsPermission') : block === 'no_agents' ? t('noAgents') : null;

  const permissionsQuery = useQuery({
    queryKey: ['iam-permissions', workspaceId],
    queryFn: () => listPermissions(workspaceId),
    enabled: open && access === 'custom',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const policyQuery = useQuery({
    queryKey: ['iam-pat-policy', accountId],
    queryFn: () => getPatPolicy(accountId),
    staleTime: 30_000,
    enabled: open,
    retry: false,
  });
  const policy = policyQuery.data ?? null;
  const expiryChoices = keyExpiryOptions(policy, tI18nComplete).map((choice) => ({
    ...choice,
    label: Number.isNaN(Number(choice.value))
      ? tTokens('expiryNever')
      : Number(choice.value) === 365
        ? tTokens('expiryOneYear')
        : tTokens('expiryDays', { count: Number(choice.value) }),
  }));
  const selectedExpiry = expiryChoices.some((o) => o.value === expiry) ? expiry : defaultKeyExpiryOption(policy, tI18nComplete);

  const principal = actsAsInput(draft);
  const ready = !!name.trim() && !!principal && !(access === 'custom' && picked.size === 0);
  const pickedBot = draft.actsAs === 'bot' && draft.bot && draft.bot !== NEW_BOT ? list?.bots.find((b) => b.bot_id === draft.bot) : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      createWorkspaceKey(workspaceId, {
        name: name.trim(),
        actsAs: principal!,
        scopes: access === 'custom' ? [...picked] : access,
        expiresAt: keyExpiresAt(selectedExpiry),
      }),
    onSuccess: (key) => {
      onCreated();
      setCreated(key);
    },
    onError: (err: Error) => errorToast(err.message || tTokens('createFailed')),
    onSettled: () => {
      submitInFlight.current = false;
    },
  });

  function close() {
    onOpenChange(false);
    setTimeout(() => {
      setName('');
      setDraft({ actsAs: 'me', agent: '', bot: '', newBotName: '' });
      setAccess('full');
      setPicked(new Set());
      setExpiry('');
      setCreated(null);
    }, 200);
  }

  const hint =
    draft.actsAs === 'me' ? t('actsAsMeHint') : draft.actsAs === 'agent' ? t('actsAsAgentHint') : t('actsAsBotHint');

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
              <ModalTitle>{tTokens('copyNow')}</ModalTitle>
              <ModalDescription>{t('createdDescription', { name: created.name, actsAs: actsAsLabel(created.acts_as) })}</ModalDescription>
            </ModalHeader>
            <ModalBody>
              <CopyRow value={created.secret_key} successMessage={tTokens('keyCopied')} />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                {tTokens('done')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>{t('newKey')}</ModalTitle>
              <ModalDescription>{t('description')}</ModalDescription>
            </ModalHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!ready || mutation.isPending || submitInFlight.current) return;
                submitInFlight.current = true;
                mutation.mutate();
              }}
            >
              <ModalBody className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="workspace-key-name">{tTokens('name')}</Label>
                  <Input
                    id="workspace-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={tTokens('namePlaceholder')}
                    disabled={mutation.isPending}
                    maxLength={128}
                    autoFocus
                    variant="popover"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="workspace-key-acts-as">{t('actsAs')}</Label>
                  <Select
                    value={draft.actsAs}
                    onValueChange={(value) => setDraft((d) => ({ ...d, actsAs: value as WorkspaceKeyPrincipal }))}
                    disabled={mutation.isPending}
                  >
                    <SelectTrigger id="workspace-key-acts-as" size="md" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          disabled={option.block !== null}
                          description={blockLabel(option.block) ?? undefined}
                        >
                          {option.value === 'me' ? t('actsAsMe') : option.value === 'agent' ? t('actsAsAgent') : t('actsAsBot')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">{hint}</p>
                </div>

                {draft.actsAs === 'agent' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-key-agent">{t('agent')}</Label>
                    <Select value={draft.agent} onValueChange={(agent) => setDraft((d) => ({ ...d, agent }))} disabled={mutation.isPending}>
                      <SelectTrigger id="workspace-key-agent" size="md" className="w-full">
                        <SelectValue placeholder={t('agentPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {(list?.agents ?? []).map((agent) => (
                          <SelectItem key={agent.name} value={agent.name}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                {draft.actsAs === 'bot' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-key-bot">{t('bot')}</Label>
                    <Select value={draft.bot} onValueChange={(bot) => setDraft((d) => ({ ...d, bot }))} disabled={mutation.isPending}>
                      <SelectTrigger id="workspace-key-bot" size="md" className="w-full">
                        <SelectValue placeholder={t('botPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {(list?.bots ?? []).map((bot) => (
                          <SelectItem key={bot.bot_id} value={bot.bot_id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                        {(list?.bots.length ?? 0) > 0 ? <SelectSeparator /> : null}
                        <SelectItem value={NEW_BOT}>{t('newBot')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {draft.bot === NEW_BOT ? (
                      <>
                        <Input
                          aria-label={t('newBotName')}
                          value={draft.newBotName}
                          onChange={(event) => setDraft((d) => ({ ...d, newBotName: event.target.value }))}
                          placeholder={t('newBotNamePlaceholder')}
                          maxLength={128}
                          disabled={mutation.isPending}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">{t('newBotHint')}</p>
                      </>
                    ) : pickedBot && !pickedBot.has_role ? (
                      <p className="text-muted-foreground text-xs">{t('botNoRole')}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor="workspace-key-access">{tWorkspaces('keyAccess')}</Label>
                  <Select value={access} onValueChange={(value) => setAccess(value as KeyAccess)} disabled={mutation.isPending}>
                    <SelectTrigger id="workspace-key-access" size="md" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">{tWorkspaces('keyAccessFull')}</SelectItem>
                      <SelectItem value="read">{tWorkspaces('keyAccessRead')}</SelectItem>
                      <SelectItem value="custom">{tWorkspaces('keyAccessCustom')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    {access === 'read' ? tWorkspaces('keyAccessReadHint') : access === 'custom' ? t('accessCustomHint') : t('accessFullHint')}
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

                <div className="space-y-1.5">
                  <Label htmlFor="workspace-key-expiry">{tTokens('expires')}</Label>
                  <Select value={selectedExpiry} onValueChange={setExpiry} disabled={mutation.isPending}>
                    <SelectTrigger id="workspace-key-expiry" size="md" className="w-full">
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
                  {policy?.require_expiry ? <p className="text-muted-foreground text-xs">{tTokens('expiryRequired')}</p> : null}
                </div>
              </ModalBody>
              <ModalFooter className="sm:justify-between">
                <Button type="button" variant="outline-ghost" size="sm" onClick={close} disabled={mutation.isPending}>
                  {tTokens('cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={!ready || mutation.isPending} className="gap-1.5">
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tTokens('createKey')}
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
