'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  type AccountSecretResource, getProjectDetail,
} from '@kortix/sdk';
import { useAccountSecretResources, useSessionProviderSecretPools } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Loading from '@/components/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState } from '@/features/layout/section/error-state';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import { errorToast, successToast } from '@/components/ui/toast';

function useResources(projectId: string) {
  const project = useQuery({ queryKey: ['provider-pool-project', projectId], queryFn: () => getProjectDetail(projectId) });
  const accountId = project.data?.project?.account_id;
  const resources = useAccountSecretResources(accountId, projectId);
  return { project, resources };
}

function usableKeys(resources: AccountSecretResource[] = []) {
  return resources.filter((secret) => secret.consumer === 'llm_gateway' && secret.provider_id && secret.can_use && secret.active);
}

function PoolChoices({ projectId, providers, providerId, onProviderChange, keys, selected, configured, disabled, onChange, onReset }: {
  projectId: string; providers: string[]; providerId: string; onProviderChange: (id: string) => void;
  keys: AccountSecretResource[]; selected: string[]; configured: boolean; disabled?: boolean;
  onChange: (ids: string[]) => void; onReset: () => void;
}) {
  const t = useTranslations('pooledSecrets');
  const id = useId();
  const available = new Set(keys.map((secret) => secret.secret_id));
  const unavailable = selected.filter((secretId) => !available.has(secretId));
  return <>
    <div className="space-y-1.5">
      <label className="text-foreground text-xs font-medium" htmlFor={id}>{t('provider')}</label>
      <Select value={providerId} onValueChange={onProviderChange} disabled={disabled}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>{providers.map((provider) => <SelectItem key={provider} value={provider}>
          {provider === 'codex' ? 'ChatGPT' : LLM_PROVIDER_BY_ID.get(provider)?.label ?? provider}
        </SelectItem>)}</SelectContent>
      </Select>
    </div>
    <p className="text-muted-foreground text-xs" aria-live="polite">{configured
      ? selected.length ? t(selected.length === 1 ? 'selectedOneForSession' : 'selectedForSession', { count: selected.length }) : t('providerDisabled')
      : t(providerId === 'codex' ? 'personalChatGptDefault' : 'projectDefault')}</p>
    {unavailable.length > 0 && <div className="space-y-1" role="status">
      <p className="text-muted-foreground text-xs">{t('unavailableKeys', { count: unavailable.length })}</p>
      <Button size="sm" variant="outline-ghost" disabled={disabled} onClick={() => onChange(selected.filter((secretId) => available.has(secretId)))}>{t('removeUnavailable')}</Button>
    </div>}
    <div className="max-h-44 space-y-1 overflow-y-auto">
      {keys.map((secret) => <label key={secret.secret_id} className="hover:bg-hover flex items-center gap-2 rounded-md px-2 py-2 text-sm">
        <Checkbox checked={selected.includes(secret.secret_id)} disabled={disabled || (!selected.includes(secret.secret_id) && selected.length >= 10)}
          onCheckedChange={(checked) => onChange(checked === true ? [...selected, secret.secret_id] : selected.filter((value) => value !== secret.secret_id))} />
        <span className="text-foreground min-w-0 truncate" title={secret.label}>{secret.label}</span>
      </label>)}
    </div>
    {selected.length >= 10 && <p className="text-muted-foreground text-xs" role="status">{t('selectionLimit')}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {configured && <Button size="sm" variant="secondary" disabled={disabled} onClick={onReset}>{t(providerId === 'codex' ? 'resetPersonalChatGptDefault' : 'resetDefault')}</Button>}
      <Button size="sm" variant="outline-ghost" asChild><Link href={`/projects/${projectId}/customize/models`}>{t('manageKeys')}</Link></Button>
    </div>
  </>;
}

export function ProviderSecretPoolEditor(props: { projectId: string; sessionId: string }) {
  return <SessionPoolEditor key={`${props.projectId}/${props.sessionId}`} {...props} />;
}

function SessionPoolEditor({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const { project, resources } = useResources(projectId);
  const pools = useSessionProviderSecretPools(projectId, sessionId);
  const usable = usableKeys(resources.data?.secrets);
  const providers = [...new Set([...usable.map((secret) => secret.provider_id!), ...(pools.data?.pools ?? []).map((pool) => pool.provider_id)])].sort();
  const [providerId, setProviderId] = useState('');
  const activeProvider = providers.includes(providerId) ? providerId : (providers[0] ?? '');
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const pool = pools.data?.pools.find((entry) => entry.provider_id === activeProvider);
  const keys = usable.filter((secret) => secret.provider_id === activeProvider);
  const selected = drafts[activeProvider] ?? pool?.secret_ids ?? [];
  const configured = activeProvider in drafts || Boolean(pool);
  const save = pools.setPool;
  const savePool = (ids: string[] | null) => {
    const provider = activeProvider;
    save.mutate({ providerId: provider, secretIds: ids }, {
      onSuccess: () => {
        setDrafts((current) => { const next = { ...current }; delete next[provider]; return next; });
        successToast(t('keysUpdated'));
      },
      onError: async (error) => {
        errorToast(error instanceof Error ? error.message : t('keysUpdateError'));
        await resources.refetch();
      },
    });
  };
  if (project.isLoading || resources.isLoading || pools.isLoading) return <div role="status" aria-label={t('loadingKeys')}><Loading /></div>;
  if (project.isError || resources.isError || pools.isError) return <ErrorState size="sm" title={t('keysLoadError')}
    action={<Button size="sm" variant="secondary" disabled={project.isFetching || resources.isFetching || pools.isFetching}
      onClick={() => { void project.refetch(); void resources.refetch(); void pools.refetch(); }}>{common('retry')}</Button>} />;
  if (!providers.length) return <div className="space-y-2"><p className="text-muted-foreground text-xs">{t('addSharedKey')}</p>
    <Button size="sm" variant="secondary" asChild><Link href={`/projects/${projectId}/customize/models`}>{t('manageKeys')}</Link></Button></div>;
  const dirty = activeProvider in drafts && (!pool || JSON.stringify(selected) !== JSON.stringify(pool.secret_ids));
  const unavailable = selected.some((id) => !keys.some((key) => key.secret_id === id));
  return <div className="space-y-3">
    <PoolChoices projectId={projectId} providers={providers} providerId={activeProvider} onProviderChange={setProviderId}
      keys={keys} selected={selected} configured={configured} disabled={save.isPending || !pools.data?.can_edit}
      onChange={(ids) => setDrafts((current) => ({ ...current, [activeProvider]: ids }))}
      onReset={() => pool ? savePool(null) : setDrafts((current) => { const next = { ...current }; delete next[activeProvider]; return next; })} />
    {pools.data?.can_edit ? <Button size="sm" disabled={save.isPending || !dirty || unavailable || selected.length > 10}
      onClick={() => savePool(selected)}>{save.isPending ? t('saving') : t('saveSelection')}</Button>
      : <p className="text-muted-foreground text-xs">{t('readOnlyPool')}</p>}
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
  if (!providers.length) return <p className="text-muted-foreground text-xs">{t('addSharedKey')}</p>;
  return <div className="space-y-3">
    <PoolChoices projectId={projectId} providers={providers} providerId={activeProvider} onProviderChange={setProviderId}
      keys={usable.filter((secret) => secret.provider_id === activeProvider)} selected={selection[activeProvider] ?? []}
      configured={activeProvider in selection} onChange={(ids) => onChange({ ...selection, [activeProvider]: ids })}
      onReset={() => { const next = { ...selection }; delete next[activeProvider]; onChange(next); }} />
  </div>;
}
