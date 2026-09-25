'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  type AccountSecretResource, getProjectDetail,
} from '@kortix/sdk';
import { useAccountSecretResources, useModelAccess, useProjectSession, useSessionProviderSecretPools } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Loading from '@/components/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState } from '@/features/layout/section/error-state';
import { ChatGptAccountsDialog } from '@/features/providers/chatgpt-accounts-dialog';
import { needsReconnection } from '@/features/workspace/customize/sections/view/account-secret-access';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import { Field, FieldLabel } from '@/components/ui/field';
import { keysForSession, normalizePoolSelection, type ProviderPoolDrafts, sessionPersonalUser } from './provider-pool-draft';

function useResources(projectId: string) {
  const project = useQuery({ queryKey: ['provider-pool-project', projectId], queryFn: () => getProjectDetail(projectId) });
  const accountId = project.data?.project?.account_id;
  const resources = useAccountSecretResources(accountId, projectId);
  return { project, resources };
}

function usableKeys(resources: AccountSecretResource[] = []) {
  return resources.filter((secret) => secret.consumer === 'llm_gateway' && secret.provider_id && secret.can_use && secret.active);
}

/** ChatGPT accounts are managed in place: a member cannot open Customize, and a
 *  link there would be a dead end. Hidden when ChatGPT is disabled for the project. */
function ChatGptAccountsButton({ projectId, variant, action, disabled }: {
  projectId: string; variant: 'secondary' | 'outline-ghost'; action: 'connect' | 'manage'; disabled?: boolean;
}) {
  const t = useTranslations('pooledSecrets');
  const [open, setOpen] = useState(false);
  const access = useModelAccess(projectId);
  if ((access.data?.disabledProviders ?? []).includes('codex')) return null;
  return <>
    <Button size="sm" variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
      {t(action === 'connect' ? 'connectChatGpt' : 'manageChatGptAccounts')}
    </Button>
    <ChatGptAccountsDialog projectId={projectId} open={open} onOpenChange={setOpen} />
  </>;
}

/** A shared session never uses a member's own ChatGPT account, so it gets the
 *  reason instead of a connect button that could not help it. */
function NoPoolKeys({ projectId, shared = false }: { projectId: string; shared?: boolean }) {
  const t = useTranslations('pooledSecrets');
  return <div className="space-y-2"><p className="text-muted-foreground text-xs">{t('addSharedKey')}</p>
    {shared && <p className="text-muted-foreground text-xs">{t('sharedSessionKeys')}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!shared && <ChatGptAccountsButton projectId={projectId} variant="secondary" action="connect" />}
      <Button size="sm" variant={shared ? 'secondary' : 'outline-ghost'} asChild><Link href={`/projects/${projectId}/customize/models`}>{t('manageKeys')}</Link></Button>
    </div></div>;
}

function PoolChoices({ projectId, providers, providerId, onProviderChange, keys, selected, configured, disabled, readOnly, personalKeys = true, onChange, onReset }: {
  projectId: string; providers: string[]; providerId: string; onProviderChange: (id: string) => void;
  keys: AccountSecretResource[]; selected: string[]; configured: boolean; disabled?: boolean; readOnly?: boolean;
  /** The session reaches its person's own connections; a shared session does not. */
  personalKeys?: boolean;
  onChange: (ids: string[]) => void; onReset: () => void;
}) {
  const t = useTranslations('pooledSecrets');
  const id = useId();
  const personalChatGpt = providerId === 'codex' && personalKeys;
  const available = new Set(keys.map((secret) => secret.secret_id));
  const unavailable = selected.filter((secretId) => !available.has(secretId));
  return <>
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>{t('provider')}</FieldLabel>
      <Select value={providerId} onValueChange={onProviderChange} disabled={disabled}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>{providers.map((provider) => <SelectItem key={provider} value={provider}>
          {provider === 'codex' ? 'ChatGPT' : LLM_PROVIDER_BY_ID.get(provider)?.label ?? provider}
        </SelectItem>)}</SelectContent>
      </Select>
    </Field>
    <p className="text-muted-foreground text-xs" aria-live="polite">{configured
      ? selected.length ? t(selected.length === 1 ? 'selectedOneForSession' : 'selectedForSession', { count: selected.length }) : t('providerDisabled')
      : t(personalChatGpt ? 'personalChatGptDefault' : 'projectDefault')}</p>
    {unavailable.length > 0 && <div className="space-y-1" role="status">
      <p className="text-muted-foreground text-xs">{t('unavailableKeys', { count: unavailable.length })}</p>
      <Button size="sm" variant="outline-ghost" disabled={disabled || readOnly} onClick={() => onChange(selected.filter((secretId) => available.has(secretId)))}>{t('removeUnavailable')}</Button>
    </div>}
    <div className="max-h-44 space-y-1 overflow-y-auto">
      {keys.map((secret) => <label key={secret.secret_id} className="hover:bg-hover has-[:focus-visible]:ring-ring flex min-h-10 items-center gap-2 rounded-md px-2 py-2 text-sm has-[:focus-visible]:ring-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        <Checkbox checked={selected.includes(secret.secret_id)} disabled={disabled || readOnly || (!selected.includes(secret.secret_id) && selected.length >= 10)}
          onCheckedChange={(checked) => onChange(checked === true ? [...selected, secret.secret_id] : selected.filter((value) => value !== secret.secret_id))} />
        <span className="text-foreground min-w-0 break-words">{secret.label}</span>
        {providerId === 'codex' && needsReconnection(secret) && (
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">{t('needsReconnection')}</span>
        )}
      </label>)}
    </div>
    {selected.length >= 10 && <p className="text-muted-foreground text-xs" role="status">{t('selectionLimit')}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {configured && !readOnly && <Button size="sm" variant="secondary" disabled={disabled} onClick={onReset}>{t(personalChatGpt ? 'resetPersonalChatGptDefault' : 'resetDefault')}</Button>}
      {providerId === 'codex'
        ? <ChatGptAccountsButton projectId={projectId} variant="outline-ghost" action="manage" disabled={disabled} />
        : disabled
          ? <Button size="sm" variant="outline-ghost" disabled>{t('manageKeys')}</Button>
          : <Button size="sm" variant="outline-ghost" asChild><Link href={`/projects/${projectId}/customize/models`}>{t('manageKeys')}</Link></Button>}
    </div>
  </>;
}

export function ProviderSecretPoolEditor({ projectId, sessionId, drafts, onChange, saving = false }: {
  projectId: string;
  sessionId: string;
  drafts: ProviderPoolDrafts;
  onChange: (providerId: string, selection: string[] | null) => void;
  saving?: boolean;
}) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const { project, resources } = useResources(projectId);
  const pools = useSessionProviderSecretPools(projectId, sessionId);
  // Only keys this session can use when it runs: a shared session never
  // reaches a key granted to one member (the server refuses the save).
  const personalUser = sessionPersonalUser(useProjectSession(projectId, sessionId).data);
  const shared = personalUser === null;
  const usable = keysForSession(usableKeys(resources.data?.secrets), personalUser);
  const providers = [...new Set([...usable.map((secret) => secret.provider_id!), ...(pools.data?.pools ?? []).map((pool) => pool.provider_id), ...Object.keys(drafts)])].sort();
  const [providerId, setProviderId] = useState('');
  const activeProvider = providers.includes(providerId) ? providerId : (providers[0] ?? '');
  const pool = pools.data?.pools.find((entry) => entry.provider_id === activeProvider);
  const keys = usable.filter((secret) => secret.provider_id === activeProvider);
  const selection = activeProvider in drafts ? drafts[activeProvider] : pool?.secret_ids;
  const selected = selection ?? [];
  const configured = selection != null;
  if (project.isLoading || resources.isLoading || pools.isLoading) return <div role="status" aria-label={t('loadingKeys')}><Loading /></div>;
  if (project.isError || resources.isError || pools.isError) return <ErrorState size="sm" title={t('keysLoadError')}
    action={<Button size="sm" variant="secondary" disabled={project.isFetching || resources.isFetching || pools.isFetching}
      onClick={() => { void project.refetch(); void resources.refetch(); void pools.refetch(); }}>{common('retry')}</Button>} />;
  if (!providers.length) return <NoPoolKeys projectId={projectId} shared={shared} />;
  return <div className="space-y-3">
    <PoolChoices projectId={projectId} providers={providers} providerId={activeProvider} onProviderChange={setProviderId}
      keys={keys} selected={selected} configured={configured} disabled={saving} readOnly={!pools.data?.can_edit}
      personalKeys={!shared}
      onChange={(ids) => onChange(activeProvider, ids)} onReset={() => onChange(activeProvider, null)} />
    {shared && <p className="text-muted-foreground text-xs">{t('sharedSessionKeys')}</p>}
    {!pools.data?.can_edit && <p className="text-muted-foreground text-xs">{t('readOnlyPool')}</p>}
  </div>;
}

export function NewProviderSecretPoolEditor({ projectId, selection, onChange }: {
  projectId: string; selection: Record<string, string[]>; onChange: (selection: Record<string, string[]>) => void;
}) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const { project, resources } = useResources(projectId);
  const usable = usableKeys(resources.data?.secrets);
  const providers = [...new Set([...usable.map((secret) => secret.provider_id!), ...Object.keys(selection)])].sort();
  const [providerId, setProviderId] = useState('');
  const activeProvider = providers.includes(providerId) ? providerId : (providers[0] ?? '');
  if (project.isLoading || resources.isLoading) return <div role="status" aria-label={t('loadingKeys')}><Loading /></div>;
  if (project.isError || resources.isError) return <ErrorState size="sm" title={t('keysLoadError')}
    action={<Button size="sm" variant="secondary" onClick={() => { void project.refetch(); void resources.refetch(); }}>{common('retry')}</Button>} />;
  if (!providers.length) return <NoPoolKeys projectId={projectId} />;
  return <div className="space-y-3">
    <PoolChoices projectId={projectId} providers={providers} providerId={activeProvider} onProviderChange={setProviderId}
      keys={usable.filter((secret) => secret.provider_id === activeProvider)} selected={selection[activeProvider] ?? []}
      configured={activeProvider in selection}
      onChange={(ids) => {
        const next = { ...selection };
        const normalized = normalizePoolSelection(ids);
        if (normalized) next[activeProvider] = normalized;
        else delete next[activeProvider];
        onChange(next);
      }}
      onReset={() => { const next = { ...selection }; delete next[activeProvider]; onChange(next); }} />
  </div>;
}
