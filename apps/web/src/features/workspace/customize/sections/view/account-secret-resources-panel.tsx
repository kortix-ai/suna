'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ApiError, type AccountSecretResource, createAccountSecretResource, deleteAccountSecretResource,
  listAccountMembers, setAccountSecretResourceAccess, rotateAccountSecretResource,
  pollProjectProviderOAuth, startProjectProviderOAuth,
} from '@kortix/sdk';
import { refreshProjectProviderState, useAccountSecretResources } from '@kortix/sdk/react';
import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DotsThreeIcon } from '@phosphor-icons/react';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { PrincipalPicker, type PrincipalSelection } from '@/features/workspace/shared/access/principal-picker';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  accessSummary, chatGptSharing, keyAccessFields, labelOwnerName, type ConnectionAccessChoice,
} from './account-secret-access';

const NO_MEMBERS: PrincipalSelection = { memberIds: [], groupIds: [], inviteEmails: [] };
type StartInput = NonNullable<Parameters<typeof startProjectProviderOAuth>[2]>;

/**
 * One ChatGPT device authorization at a time. A newer start or a cancel bumps
 * the generation, so a stale poll never updates a later dialog. Failures stay
 * in `error` for the dialog to show; they are not only toasts.
 */
function useChatGptAuthorization(projectId: string | undefined) {
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const [challenge, setChallenge] = useState<{ url: string; code: string | null } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(() => {
    generation.current++;
    setWaiting(false); setChallenge(null); setError(null);
  }, []);
  const authorize = useCallback(async (input: StartInput, messages: { expired: string; failed: string }) => {
    if (!projectId) return null;
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    setWaiting(true); setChallenge(null); setError(null);
    try {
      const start = await startProjectProviderOAuth(projectId, 'openai', input);
      if (!isCurrent()) return null;
      setChallenge({ url: start.verification_url, code: start.user_code });
      let interval = Math.max(2000, start.interval_ms || 3000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (isCurrent() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        if (!isCurrent()) return null;
        let result: Awaited<ReturnType<typeof pollProjectProviderOAuth>>;
        try {
          result = await pollProjectProviderOAuth(projectId, 'openai', start.flow_id);
        } catch (err) {
          if (!isCurrent()) return null;
          if (err instanceof ApiError && err.status && err.status < 500 && ![408, 429].includes(err.status)) throw err;
          continue;
        }
        if (!isCurrent()) return null;
        if (result.status === 'pending') {
          interval = Math.max(interval, result.next_poll_ms ?? interval);
          continue;
        }
        if (result.status === 'success') {
          setWaiting(false); setChallenge(null);
          return result.credential;
        }
        throw new Error(result.status === 'failed' ? result.error : messages.expired);
      }
      if (isCurrent()) throw new Error(messages.expired);
      return null;
    } catch (err) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : messages.failed);
        setWaiting(false); setChallenge(null);
      }
      return null;
    }
  }, [projectId]);
  return { challenge, waiting, error, authorize, cancel };
}

/**
 * Provider keys live beside the provider they configure. The secret value stays
 * write-only. With `oauth`, the panel manages ChatGPT accounts: any project
 * member can connect their own subscription ("Only you"); sharing one with
 * others needs `project.secret.write`, the same rule the API enforces.
 */
export function AccountSecretResourcesPanel({ accountId, projectId, providerId, providerName, envVar, canWrite, oauth }: {
  accountId: string;
  projectId: string;
  providerId: string;
  providerName: string;
  envVar: string;
  canWrite: boolean;
  oauth?: { projectId: string; onConnected: (providerId: string) => void };
}) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['account-secret-resources', accountId, projectId] as const;
  const resources = useAccountSecretResources(accountId, projectId);
  // Hide share controls on anything but an explicit grant: an owner-only
  // connection is always allowed, so a slow probe never blocks the common case.
  const canShare = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE).allowed === true;
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [rotating, setRotating] = useState<AccountSecretResource | null>(null);
  const [reconnecting, setReconnecting] = useState<AccountSecretResource | null>(null);
  const [sharing, setSharing] = useState<AccountSecretResource | null>(null);
  // New connections are private to their creator: sharing is opt-in.
  const [createMode, setCreateMode] = useState<ConnectionAccessChoice>('private');
  const [sharingMode, setSharingMode] = useState<'project' | 'members'>('project');
  const [selectedMembers, setSelectedMembers] = useState<PrincipalSelection>(NO_MEMBERS);
  const [deleting, setDeleting] = useState<AccountSecretResource | null>(null);
  const authorization = useChatGptAuthorization(oauth?.projectId);
  const members = useQuery({ queryKey: ['account-members', accountId], queryFn: () => listAccountMembers(accountId) });
  const actorRole = members.data?.find((member) => member.user_id === user?.id)?.account_role;
  const keys = (resources.data?.secrets ?? []).filter((secret) => secret.provider_id === providerId);
  const manageable = (secret: AccountSecretResource) =>
    secret.created_by === user?.id || actorRole === 'owner' || actorRole === 'admin';
  const authMessages = { expired: t('oauthExpired'), failed: t('connectFailed') };
  const defaultLabel = () => {
    const name = labelOwnerName(user);
    return oauth && name ? t('defaultAccountLabel', { name }) : '';
  };
  const closeCreate = () => {
    authorization.cancel();
    setCreating(false); setRotating(null); setValue('');
  };
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
    refreshProjectProviderState(queryClient, projectId);
    await queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pools'] });
  };
  const connectOAuth = async () => {
    if (!oauth || !label.trim()) return;
    const credential = await authorization.authorize({
      resourceLabel: label.trim(),
      sharing: chatGptSharing(createMode, selectedMembers.memberIds, user?.id),
    }, authMessages);
    if (!credential) return;
    await refresh();
    oauth.onConnected('codex');
    setCreating(false); setLabel('');
    successToast(t('accountConnected'));
  };
  const reconnectOAuth = async (secret: AccountSecretResource) => {
    const credential = await authorization.authorize({ resourceId: secret.secret_id }, authMessages);
    if (!credential) return;
    await refresh();
    oauth?.onConnected('codex');
    setReconnecting(null);
    successToast(t('accountReconnected'));
  };
  const openReconnect = (secret: AccountSecretResource) => {
    setReconnecting(secret);
    // Reconnect has nothing to fill in: go straight to the device code.
    void reconnectOAuth(secret);
  };
  const closeReconnect = () => {
    authorization.cancel();
    setReconnecting(null);
  };
  const save = useMutation({
    mutationFn: async () => {
      if (rotating) return rotateAccountSecretResource(accountId, rotating.secret_id, value);
      return createAccountSecretResource(accountId, {
        project_id: projectId, ...keyAccessFields(createMode, selectedMembers.memberIds),
        provider_id: providerId, name: envVar, label: label.trim(),
        value, consumer: 'llm_gateway', strategy: 'broker',
      });
    },
    onSuccess: async () => {
      await refresh();
      setCreating(false); setRotating(null); setLabel(''); setValue('');
      successToast(t('saved'));
    },
    onError: (error) => errorToast(error instanceof Error ? error.message : t('saveError')),
  });
  const remove = useMutation({
    mutationFn: (secretId: string) => deleteAccountSecretResource(accountId, secretId),
    onSuccess: async () => { await refresh(); setDeleting(null); successToast(t('deleted')); },
    onError: (error) => errorToast(error instanceof Error ? error.message : t('deleteError')),
  });
  const changeGrant = useMutation({
    mutationFn: async () => {
      if (!sharing) return;
      return setAccountSecretResourceAccess(accountId, sharing.secret_id, sharingMode, selectedMembers.memberIds);
    },
    onSuccess: () => { setSharing(null); successToast(t('saved')); },
    onSettled: async () => {
      const updated = await resources.refetch();
      setSharing((current) => current ? updated.data?.secrets.find((secret) => secret.secret_id === current.secret_id) ?? current : null);
      refreshProjectProviderState(queryClient, projectId);
      await queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pools'] });
    },
  });
  const openCreate = () => {
    setCreateMode('private');
    setSelectedMembers(NO_MEMBERS);
    setLabel(defaultLabel());
    save.reset();
    authorization.cancel();
    setCreating(true);
  };
  const accessLine = (secret: AccountSecretResource) => {
    const summary = accessSummary(secret, user?.id);
    if (summary.kind === 'project') return t('everyoneInProject');
    if (summary.kind === 'you') return t('onlyYou');
    if (summary.kind === 'owner') {
      const email = members.data?.find((member) => member.user_id === summary.ownerId)?.email;
      return email ? t('onlyOwner', { name: email }) : t('selectedMembersCount', { count: 1 });
    }
    return t('selectedMembersCount', { count: summary.count });
  };
  const busy = save.isPending || authorization.waiting;
  // Only a successful read can say "no accounts"; loading and errors say so themselves.
  const empty = Boolean(oauth) && resources.isSuccess && keys.length === 0;

  return (
    <section className="min-w-0 space-y-2" aria-label={oauth ? t('chatGptAccounts') : t('providerKeysFor', { provider: providerName })}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {!resources.isSuccess ? null : empty ? t('noChatGptAccounts')
            : oauth ? t('accountCount', { count: keys.length }) : t('keyCount', { count: keys.length })}
        </p>
        {canWrite && <Button size="sm" variant={empty ? 'default' : 'secondary'} onClick={openCreate}>
          {empty ? t('connectChatGpt') : oauth ? t('addAccount') : t('addKey')}
        </Button>}
      </div>
      {resources.isLoading ? <div role="status" aria-label={t('loadingKeys')}><Loading /></div> : resources.isError ? (
        <ErrorState size="sm" title={t('loadError')} action={<Button size="sm" variant="secondary" disabled={resources.isFetching} onClick={() => void resources.refetch()}>{common('retry')}</Button>} />
      ) : keys.length ? (
        <ul className="space-y-1">{keys.map((secret) => {
          const canManage = canWrite && manageable(secret);
          const canReconnect = Boolean(oauth) && canWrite && secret.created_by === user?.id;
          const canChangeAccess = canManage && canShare;
          return (
            <li key={secret.secret_id} className="border-border flex min-w-0 items-center gap-3 rounded-md border px-3 py-1.5">
              <span className="text-foreground min-w-0 flex-1 text-sm font-medium">
                <span className="block break-words">{secret.label}</span>
                <span className="text-muted-foreground block text-xs font-normal">{accessLine(secret)}</span>
                {!secret.active && oauth && (
                  <span className="text-muted-foreground block text-xs font-normal">{t('needsReconnection')}</span>
                )}
                {secret.cooldown_until && Date.parse(secret.cooldown_until) > resources.dataUpdatedAt && (
                  <span className="text-muted-foreground block text-xs font-normal">{t('coolingDown')}</span>
                )}
              </span>
              {(canManage || canReconnect) && <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={t('actionsFor', { label: secret.label })}><DotsThreeIcon className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canReconnect && <DropdownMenuItem onSelect={() => openReconnect(secret)}>{t('reconnectAccount')}</DropdownMenuItem>}
                  {canChangeAccess && <DropdownMenuItem onSelect={() => { changeGrant.reset(); setSharingMode(secret.access_mode); setSelectedMembers({ memberIds: secret.granted_user_ids, groupIds: [], inviteEmails: [] }); setSharing(secret); }}>{t('manageAccess')}</DropdownMenuItem>}
                  {canManage && !oauth && <DropdownMenuItem onSelect={() => { setValue(''); save.reset(); setRotating(secret); }}>{t('rotateKey')}</DropdownMenuItem>}
                  {canManage && <DropdownMenuItem onSelect={() => setDeleting(secret)}>{oauth ? t('deleteAccount') : t('deleteKey')}</DropdownMenuItem>}
                </DropdownMenuContent>
              </DropdownMenu>}
            </li>
          );
        })}</ul>
      ) : null}

      <Modal open={creating || rotating !== null} onOpenChange={(open) => { if (!open && !save.isPending) closeCreate(); }}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader><ModalTitle>{rotating ? t('rotateLabel', { label: rotating.label }) : `${oauth ? t('addAccount') : t('addKey')} · ${providerName}`}</ModalTitle>
            <ModalDescription>{t(rotating ? 'valueNeverShown' : oauth ? 'oauthCreationDescription' : 'creationDescription')}</ModalDescription></ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-3 overflow-y-auto">
            {save.isError && <p role="alert" className="text-destructive text-sm">{save.error instanceof Error ? save.error.message : t('saveError')}</p>}
            {oauth && authorization.error && <p role="alert" className="text-destructive text-sm">{authorization.error}</p>}
            {!rotating && <>
              <Field><FieldLabel htmlFor={`provider-key-label-${providerId}`}>{t('label')}</FieldLabel><Input id={`provider-key-label-${providerId}`} value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} placeholder={oauth ? t('accountLabelPlaceholder') : t('primaryKey')} maxLength={100} /></Field>
            </>}
            {oauth ? authorization.challenge && <ChatGptDeviceChallenge url={authorization.challenge.url} code={authorization.challenge.code} /> :
              <Field><FieldLabel htmlFor={`provider-key-value-${providerId}`}>{t('apiKey')}</FieldLabel><Input id={`provider-key-value-${providerId}`} type="password" value={value} disabled={save.isPending} onChange={(event) => setValue(event.target.value)} autoComplete="off" /></Field>}
            {!rotating && !authorization.challenge && <div className="space-y-2">
              <FieldLabel>{t('whoCanUse')}</FieldLabel>
              <RadioGroup value={createMode} onValueChange={(next) => setCreateMode(next as ConnectionAccessChoice)} className="space-y-2">
                <RadioGroupItem value="private" id={`create-${providerId}-private`} label={t('onlyYou')} description={t('onlyYouDescription')} size="lg" variant="outline" disabled={busy} />
                <RadioGroupItem value="project" id={`create-${providerId}-project`} label={t('everyoneInProject')} description={t('everyoneDescription')} size="lg" variant="outline" disabled={busy || !canShare} />
                <RadioGroupItem value="members" id={`create-${providerId}-members`} label={t('specificMembers')} description={t('specificDescription')} size="lg" variant="outline" disabled={busy || !canShare} />
              </RadioGroup>
              {!canShare && <p className="text-muted-foreground text-xs">{t('shareRequiresPermission')}</p>}
              {createMode === 'members' && <PrincipalPicker scope={{ kind: 'project', projectId }} selection="multi" kinds={['member']}
                value={selectedMembers} onChange={setSelectedMembers} disabled={busy} autoFocus={false} />}
            </div>}
          </ModalBody>
          <ModalFooter><Button variant="secondary" disabled={save.isPending} onClick={closeCreate}>{t('cancel')}</Button>
            <Button disabled={oauth ? authorization.waiting || !label.trim() : save.isPending || !value.trim() || (!rotating && !label.trim())}
              onClick={() => oauth ? void connectOAuth() : save.mutate()}>
              {oauth ? authorization.waiting ? t('oauthWaiting') : authorization.error ? common('retry') : t('connectAccount') : save.isPending ? t('saving') : t('saveKey')}
            </Button></ModalFooter>
        </ModalContent>
      </Modal>

      {oauth && <Modal open={reconnecting !== null} onOpenChange={(open) => { if (!open) closeReconnect(); }}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader><ModalTitle>{t('reconnectTitle', { label: reconnecting?.label ?? '' })}</ModalTitle>
            <ModalDescription>{t('reconnectDescription')}</ModalDescription></ModalHeader>
          <ModalBody className="space-y-3">
            {authorization.error && <p role="alert" className="text-destructive text-sm">{authorization.error}</p>}
            {authorization.challenge
              ? <ChatGptDeviceChallenge url={authorization.challenge.url} code={authorization.challenge.code} />
              : authorization.waiting && <div role="status" aria-label={t('oauthWaiting')}><Loading /></div>}
          </ModalBody>
          <ModalFooter><Button variant="secondary" onClick={closeReconnect}>{t('cancel')}</Button>
            <Button disabled={authorization.waiting || !reconnecting} onClick={() => { if (reconnecting) void reconnectOAuth(reconnecting); }}>
              {authorization.waiting ? t('oauthWaiting') : authorization.error ? common('retry') : t('reconnectAccount')}
            </Button></ModalFooter>
        </ModalContent>
      </Modal>}

      <Modal open={sharing !== null} onOpenChange={(open) => { if (!open && !changeGrant.isPending) setSharing(null); }}>
        <ModalContent className="lg:max-w-md"><ModalHeader><ModalTitle>{t('accessTo', { label: sharing?.label ?? '' })}</ModalTitle>
          <ModalDescription>{t('accessDescription')}</ModalDescription></ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            {changeGrant.isError && <p role="alert" className="text-destructive text-sm">{t('accessError')}</p>}
            <RadioGroup value={sharingMode} onValueChange={(next) => setSharingMode(next as 'project' | 'members')} className="space-y-2">
              <RadioGroupItem value="project" id={`access-${providerId}-project`} label={t('everyoneInProject')} description={t('everyoneDescription')} size="lg" variant="outline" disabled={changeGrant.isPending} />
              <RadioGroupItem value="members" id={`access-${providerId}-members`} label={t('specificMembers')} description={t('specificDescription')} size="lg" variant="outline" disabled={changeGrant.isPending} />
            </RadioGroup>
            {sharingMode === 'members' && <Field className="gap-1.5"><PrincipalPicker scope={{ kind: 'project', projectId }} selection="multi" kinds={['member']}
              value={selectedMembers} onChange={setSelectedMembers} disabled={changeGrant.isPending} autoFocus={false} /></Field>}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button size="sm" variant="outline-ghost" disabled={changeGrant.isPending} onClick={() => setSharing(null)}>{t('cancel')}</Button>
            <Button size="sm" disabled={changeGrant.isPending} onClick={() => changeGrant.mutate()}>{changeGrant.isPending ? t('saving') : t('done')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <ConfirmDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t(oauth ? 'deleteAccountConfirmTitle' : 'deleteConfirmTitle')}
        description={deleting ? t(oauth ? 'deleteAccountConfirmDescription' : 'deleteConfirmDescription', { label: deleting.label }) : ''}
        confirmLabel={oauth ? t('deleteAccount') : t('deleteKey')} confirmVariant="destructive" isPending={remove.isPending}
        onConfirm={() => { if (deleting) remove.mutate(deleting.secret_id); }} />
    </section>
  );
}
