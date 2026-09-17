'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
import { useAuth } from '@/features/providers/auth-provider';
import { PrincipalPicker, type PrincipalSelection } from '@/features/workspace/shared/access/principal-picker';

/** Provider keys live beside the provider they configure. The secret value stays write-only. */
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
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['account-secret-resources', accountId, projectId] as const;
  const resources = useAccountSecretResources(accountId, projectId);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [rotating, setRotating] = useState<AccountSecretResource | null>(null);
  const [sharing, setSharing] = useState<AccountSecretResource | null>(null);
  const [createMode, setCreateMode] = useState<'project' | 'members'>('project');
  const [sharingMode, setSharingMode] = useState<'project' | 'members'>('project');
  const [selectedMembers, setSelectedMembers] = useState<PrincipalSelection>({ memberIds: [], groupIds: [], inviteEmails: [] });
  const [deleting, setDeleting] = useState<AccountSecretResource | null>(null);
  const [oauthChallenge, setOauthChallenge] = useState<{ url: string; code: string | null } | null>(null);
  const [oauthWaiting, setOauthWaiting] = useState(false);
  const oauthGeneration = useRef(0);
  useEffect(() => () => { oauthGeneration.current++; }, []);
  const members = useQuery({ queryKey: ['account-members', accountId], queryFn: () => listAccountMembers(accountId) });
  const actorRole = members.data?.find((member) => member.user_id === user?.id)?.account_role;
  const keys = (resources.data?.secrets ?? []).filter((secret) => secret.provider_id === providerId);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
    refreshProjectProviderState(queryClient, projectId);
    await queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pools'] });
  };
  const connectOAuth = async () => {
    if (!oauth || !label.trim()) return;
    const generation = ++oauthGeneration.current;
    const isCurrent = () => generation === oauthGeneration.current;
    setOauthWaiting(true);
    setOauthChallenge(null);
    try {
      const start = await startProjectProviderOAuth(oauth.projectId, 'openai', {
        resourceLabel: label.trim(),
        sharing: createMode === 'project' ? { mode: 'project' } : { mode: 'members', memberIds: selectedMembers.memberIds },
      });
      if (!isCurrent()) return;
      setOauthChallenge({ url: start.verification_url, code: start.user_code });
      let interval = Math.max(2000, start.interval_ms || 3000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (isCurrent() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        if (!isCurrent()) return;
        let result: Awaited<ReturnType<typeof pollProjectProviderOAuth>>;
        try {
          result = await pollProjectProviderOAuth(oauth.projectId, 'openai', start.flow_id);
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof ApiError && error.status && error.status < 500 && ![408, 429].includes(error.status)) throw error;
          continue;
        }
        if (!isCurrent()) return;
        if (result.status === 'pending') {
          interval = Math.max(interval, result.next_poll_ms ?? interval);
          continue;
        }
        if (result.status === 'success') {
          await refresh();
          if (!isCurrent()) return;
          oauth.onConnected('codex');
          setCreating(false); setLabel(''); setOauthChallenge(null);
          successToast(t('saved'));
          return;
        }
        throw new Error(result.status === 'failed' ? result.error : t('oauthExpired'));
      }
      if (isCurrent()) throw new Error(t('oauthExpired'));
    } catch (error) {
      if (isCurrent()) errorToast(error instanceof Error ? error.message : t('saveError'));
    } finally {
      if (isCurrent()) setOauthWaiting(false);
    }
  };
  const save = useMutation({
    mutationFn: async () => {
      if (rotating) return rotateAccountSecretResource(accountId, rotating.secret_id, value);
      return createAccountSecretResource(accountId, {
        project_id: projectId, access_mode: createMode, user_ids: createMode === 'members' ? selectedMembers.memberIds : [],
        provider_id: providerId, name: envVar, label: label.trim(),
        value, consumer: 'llm_gateway', strategy: 'broker',
      });
    },
    onSuccess: async () => {
      await refresh();
      setCreating(false); setRotating(null); setLabel(''); setValue(''); setCreateMode('project');
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

  return (
    <section className="min-w-0 space-y-2" aria-label={oauth ? t('chatGptAccounts') : t('providerKeysFor', { provider: providerName })}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">{oauth ? t('accountCount', { count: keys.length }) : t('keyCount', { count: keys.length })}</p>
        {canWrite && <Button size="sm" variant="secondary" onClick={() => { setCreateMode('project'); setSelectedMembers({ memberIds: [], groupIds: [], inviteEmails: [] }); setCreating(true); }}>{oauth ? t('addAccount') : t('addKey')}</Button>}
      </div>
      {resources.isLoading ? <Loading /> : resources.isError ? (
        <p className="text-muted-foreground text-xs">{t('loadError')}</p>
      ) : keys.length ? (
        <ul className="space-y-1">{keys.map((secret) => (
            <li key={secret.secret_id} className="border-border flex min-w-0 items-center gap-3 rounded-md border px-3 py-1.5">
              <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                <span>{secret.label}</span>
                {secret.cooldown_until && Date.parse(secret.cooldown_until) > resources.dataUpdatedAt && (
                  <span className="text-muted-foreground block text-xs font-normal">{t('coolingDown')}</span>
                )}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{secret.access_mode === 'project' ? t('everyoneInProject') : t('selectedMembersCount', { count: secret.granted_user_ids.length })}</span>
              {canWrite && (secret.created_by === user?.id || actorRole === 'owner' || actorRole === 'admin') && <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={t('actionsFor', { label: secret.label })}><DotsThreeIcon className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => { changeGrant.reset(); setSharingMode(secret.access_mode); setSelectedMembers({ memberIds: secret.granted_user_ids, groupIds: [], inviteEmails: [] }); setSharing(secret); }}>{t('manageAccess')}</DropdownMenuItem>
                  {!oauth && <DropdownMenuItem onSelect={() => { setValue(''); setRotating(secret); }}>{t('rotateKey')}</DropdownMenuItem>}
                  <DropdownMenuItem onSelect={() => setDeleting(secret)}>{oauth ? t('deleteAccount') : t('deleteKey')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}
            </li>
          ))}</ul>
      ) : null}

      <Modal open={creating || rotating !== null} onOpenChange={(open) => { if (!open && !save.isPending) { oauthGeneration.current++; setCreating(false); setRotating(null); setValue(''); setOauthWaiting(false); setOauthChallenge(null); } }}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader><ModalTitle>{rotating ? t('rotateLabel', { label: rotating.label }) : `${oauth ? t('addAccount') : t('addKey')} · ${providerName}`}</ModalTitle>
            <ModalDescription>{t(rotating ? 'valueNeverShown' : 'creationDescription')}</ModalDescription></ModalHeader>
          <ModalBody className="space-y-3">
            {!rotating && <>
              <Field><FieldLabel htmlFor={`provider-key-label-${providerId}`}>{t('label')}</FieldLabel><Input id={`provider-key-label-${providerId}`} value={label} disabled={oauthWaiting || save.isPending} onChange={(event) => setLabel(event.target.value)} placeholder={oauth ? t('accountLabelPlaceholder') : t('primaryKey')} maxLength={100} /></Field>
            </>}
            {oauth ? oauthChallenge && <ChatGptDeviceChallenge url={oauthChallenge.url} code={oauthChallenge.code} /> :
              <Field><FieldLabel htmlFor={`provider-key-value-${providerId}`}>{t('apiKey')}</FieldLabel><Input id={`provider-key-value-${providerId}`} type="password" value={value} disabled={save.isPending} onChange={(event) => setValue(event.target.value)} autoComplete="off" /></Field>}
            {!rotating && !oauthChallenge && <div className="space-y-2">
              <FieldLabel>{t('whoCanUse')}</FieldLabel>
              <RadioGroup value={createMode} onValueChange={(value) => setCreateMode(value as 'project' | 'members')} className="space-y-2">
                <RadioGroupItem value="project" id={`create-${providerId}-project`} label={t('everyoneInProject')} description={t('everyoneDescription')} size="lg" variant="outline" />
                <RadioGroupItem value="members" id={`create-${providerId}-members`} label={t('specificMembers')} description={t('specificDescription')} size="lg" variant="outline" />
              </RadioGroup>
              {createMode === 'members' && <PrincipalPicker scope={{ kind: 'project', projectId }} selection="multi" kinds={['member']}
                value={selectedMembers} onChange={setSelectedMembers} autoFocus={false} />}
            </div>}
          </ModalBody>
          <ModalFooter><Button variant="secondary" disabled={save.isPending} onClick={() => { oauthGeneration.current++; setCreating(false); setRotating(null); setValue(''); setOauthWaiting(false); setOauthChallenge(null); }}>{t('cancel')}</Button>
            <Button disabled={oauth ? oauthWaiting || !label.trim() : save.isPending || !value.trim() || (!rotating && !label.trim())}
              onClick={() => oauth ? void connectOAuth() : save.mutate()}>{oauth ? oauthWaiting ? t('oauthWaiting') : t('connectAccount') : save.isPending ? t('saving') : t('saveKey')}</Button></ModalFooter>
        </ModalContent>
      </Modal>

      <Modal open={sharing !== null} onOpenChange={(open) => { if (!open && !changeGrant.isPending) setSharing(null); }}>
        <ModalContent className="lg:max-w-md"><ModalHeader><ModalTitle>{t('accessTo', { label: sharing?.label ?? '' })}</ModalTitle>
          <ModalDescription>{t('accessDescription')}</ModalDescription></ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            {changeGrant.isError && <p role="alert" className="text-destructive text-sm">{t('accessError')}</p>}
            <RadioGroup value={sharingMode} onValueChange={(value) => setSharingMode(value as 'project' | 'members')} className="space-y-2">
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
