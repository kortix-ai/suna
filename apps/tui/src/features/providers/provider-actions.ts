/**
 * Everything the provider sheet reads and writes through `@kortix/sdk`: what
 * is connected (`useProviderConnection`) and the writes a flow step ends in
 * (`useProviderActions`). The sheet draws; this file talks to the API.
 */

import {
  type AccountSecretResource,
  type ConnectionAccessChoice,
  type LlmProviderEntry,
  PROVIDER_SUBSCRIPTIONS,
  connectionLabelOwnerName,
  connectionSharing,
  createAccountSecretResource,
  deleteAccountSecretResource,
  listAccountSecretResources,
  refreshAccountSecretUsage,
  providerDisconnectPlan,
  providerKeyAccessFields,
  rotateAccountSecretResource,
  setAccountSecretResourceAccess,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { kortix } from '../../kortix.ts';
import { type SheetFlow, VIEW, useSheetRun } from '../../ui/sheet-flow.ts';
import type { ProviderSheetProps } from './provider-sheet.tsx';
import type { AccountMode, Flow } from './provider-flow.ts';
import { accountsFor, providerSheetKind } from './providers-model.ts';
import type { ProvidersData } from './use-providers.ts';
import type { SignInTarget, UseSignIn } from './use-sign-in.ts';

export type ProviderConnection = ReturnType<typeof useProviderConnection>;
export type ProviderActions = ReturnType<typeof useProviderActions>;

/** What this provider has connected, and what the viewer may do with it. */
export function useProviderConnection(projectId: string, entry: LlmProviderEntry, data: ProvidersData, cursor: number) {
  const sheet = providerSheetKind(entry, data.pooled && Boolean(data.accountId));
  const subscription = PROVIDER_SUBSCRIPTIONS[entry.id];

  const accountProviderId =
    sheet === 'pooled-chatgpt' ? 'codex' : sheet === 'pooled-claude' ? 'claude-agent' : entry.id;
  const accounts = useMemo(() => accountsFor(data.accounts, accountProviderId), [data.accounts, accountProviderId]);
  // Claude also lists Anthropic API keys under its accounts, as the web does.
  const anthropicKeys = useMemo(
    () => (sheet === 'pooled-claude' ? accountsFor(data.accounts, 'anthropic') : []),
    [data.accounts, sheet],
  );
  const rows = useMemo(() => [...accounts, ...anthropicKeys], [accounts, anthropicKeys]);
  const current = rows[Math.min(cursor, Math.max(rows.length - 1, 0))] ?? null;
  const currentIsKey = current ? anthropicKeys.includes(current) || sheet === 'pooled-key' : false;

  const keyConnected = data.connectedIds.has(entry.id);
  const logins = useQuery({
    queryKey: ['tui', 'provider-logins', projectId],
    queryFn: () => kortix().project(projectId).secrets.listProviderOAuth(),
    enabled: sheet === 'subscription' && subscription?.kind === 'opencode-go',
  });
  const claude = useQuery({
    queryKey: ['claude-subscription', projectId],
    queryFn: () => kortix().project(projectId).claudeSubscription.get(),
    enabled: sheet === 'subscription' && subscription?.kind === 'claude',
  });
  const signedIn =
    sheet !== 'subscription' || !subscription
      ? false
      : subscription.kind === 'chatgpt'
        ? data.connectedIds.has('codex')
        : subscription.kind === 'claude'
          ? claude.data?.connected === true
          : (logins.data ?? []).some((login) => login.provider_id === subscription.oauthProvider);

  const isDefault = data.defaultProvider === entry.id;
  const enabled = !data.disabledProviders.has(entry.id);
  const canShare = data.canWrite;
  const oauthMode: AccountMode = sheet === 'pooled-chatgpt' || sheet === 'pooled-claude' ? 'oauth' : 'key';
  const accountNoun = sheet === 'pooled-claude' ? 'Claude' : 'ChatGPT';
  // Each login's plan windows, read fresh while the sheet is open (the server
  // asks the provider at most once a minute per login); the list's snapshot until then.
  const usage = useQuery({
    queryKey: ['tui', 'subscription-usage', data.accountId, accounts.map((secret) => secret.secret_id).join(',')],
    queryFn: async () => new Map(await Promise.all(accounts.map(async (secret) => [
      secret.secret_id,
      await refreshAccountSecretUsage(data.accountId!, secret.secret_id).catch(() => null),
    ] as const))),
    enabled: oauthMode === 'oauth' && Boolean(data.accountId) && accounts.length > 0,
    refetchInterval: 60_000,
  });

  return {
    sheet,
    subscription,
    accounts,
    anthropicKeys,
    rows,
    current,
    currentIsKey,
    keyConnected,
    signedIn,
    isDefault,
    enabled,
    canShare,
    oauthMode,
    accountNoun,
    usage,
  };
}

interface ProviderActionsInput
  extends Pick<SheetFlow<Flow>, 'setFlow'>,
    Pick<ProviderSheetProps, 'projectId' | 'entry' | 'data' | 'onToast'> {
  connection: Pick<ProviderConnection, 'sheet' | 'subscription' | 'accountNoun' | 'anthropicKeys'>;
  signIn: UseSignIn;
}

/** The writes. Each one ends its flow step: pending, refresh, toast, back to the view. */
export function useProviderActions({ projectId, entry, data, connection, signIn, setFlow, onToast }: ProviderActionsInput) {
  const { sheet, subscription, accountNoun, anthropicKeys } = connection;
  const { pending, run } = useSheetRun({ setFlow, onToast, refresh: data.refresh });

  const viewerLabel = useCallback(() => {
    const name = connectionLabelOwnerName(data.viewerEmail ? { email: data.viewerEmail } : null);
    return name ? `${accountNoun} · ${name}` : '';
  }, [data.viewerEmail, accountNoun]);

  const startSignIn = useCallback(
    async (target: SignInTarget, reconnecting?: string) => {
      if (!subscription) return;
      setFlow({ kind: 'signin', code: '', reconnecting });
      const ok = await signIn.start(
        subscription.kind === 'claude'
          ? { kind: 'claude' }
          : { kind: 'device', provider: subscription.oauthProvider ?? entry.id },
        target,
      );
      if (!ok) return;
      await data.refresh(subscription.modelProviderId);
      onToast(
        reconnecting
          ? `${accountNoun} account reconnected`
          : `Connected ${subscription.name}. /model lists its models.`,
      );
      setFlow(VIEW);
    },
    [subscription, signIn, entry.id, data, onToast, setFlow, accountNoun],
  );

  const finishAccess = useCallback(
    (f: { purpose: 'create' | 'manage'; mode: AccountMode; label: string; secret?: AccountSecretResource }, choice: ConnectionAccessChoice, memberIds: string[]) => {
      if (f.purpose === 'manage' && f.secret && data.accountId) {
        const secret = f.secret;
        const accountId = data.accountId;
        void run(
          'Saving access',
          () => setAccountSecretResourceAccess(accountId, secret.secret_id, choice === 'project' ? 'project' : 'members', memberIds),
          'Access saved',
        );
        return;
      }
      if (f.mode === 'oauth') {
        void startSignIn({ resourceLabel: f.label, sharing: connectionSharing(choice, memberIds, data.viewerId) });
        return;
      }
      setFlow({
        kind: 'key',
        fields: [entry.envVars[0] ?? 'API_KEY'],
        index: 0,
        values: {},
        purpose: 'account-new',
        label: f.label,
        access: { choice, memberIds },
      });
    },
    [data.accountId, data.viewerId, entry.envVars, run, setFlow, startSignIn],
  );

  const saveKey = useCallback(
    (f: Extract<Flow, { kind: 'key' }>) => {
      const accountId = data.accountId;
      if (f.purpose === 'project') {
        void run(
          'Saving key',
          () =>
            Promise.all(
              f.fields.map((name) =>
                kortix().project(projectId).secrets.upsert({
                  name,
                  value: (f.values[name] ?? '').trim(),
                  strategy: 'broker',
                  consumer: 'llm_gateway',
                }),
              ),
            ),
          `${entry.label} connected. /model lists its models.`,
          entry.id,
        );
        return;
      }
      if (!accountId) return;
      const value = (f.values[f.fields[0]!] ?? '').trim();
      if (f.purpose === 'account-rotate' && f.secret) {
        const secret = f.secret;
        void run('Saving key', () => rotateAccountSecretResource(accountId, secret.secret_id, value), 'Secret saved');
        return;
      }
      const target = anthropicKeys.length || sheet === 'pooled-claude' ? 'anthropic' : entry.id;
      void run(
        'Saving key',
        () =>
          createAccountSecretResource(accountId, {
            project_id: projectId,
            ...providerKeyAccessFields(f.access?.choice ?? 'private', f.access?.memberIds ?? []),
            provider_id: target,
            name: f.fields[0]!,
            label: f.label ?? '',
            value,
            consumer: 'llm_gateway',
            strategy: 'broker',
          }),
        'Secret saved',
        target,
      );
    },
    [data.accountId, run, projectId, entry, anthropicKeys.length, sheet],
  );

  const confirm = useCallback(
    (f: Extract<Flow, { kind: 'confirm' }>) => {
      const accountId = data.accountId;
      if (f.action === 'delete-account' && f.secret && accountId) {
        const secret = f.secret;
        void run('Deleting', () => deleteAccountSecretResource(accountId, secret.secret_id), 'Secret deleted');
        return;
      }
      if (f.action === 'remove-key') {
        const plan = providerDisconnectPlan(entry);
        const secrets = kortix().project(projectId).secrets;
        void run(
          'Removing key',
          () =>
            Promise.all([
              ...(plan.oauthProvider ? [secrets.removeProviderOAuth(plan.oauthProvider)] : []),
              ...plan.secretNames.map((name) => secrets.remove(name)),
            ]),
          `${entry.label} disconnected`,
        );
        return;
      }
      if (f.action === 'disconnect' && subscription) {
        void run(
          'Disconnecting',
          async () => {
            if (subscription.kind !== 'claude') {
              await kortix().project(projectId).secrets.removeProviderOAuth(subscription.oauthProvider ?? entry.id);
              return;
            }
            // The caller's own Claude accounts; one shared by someone else stays theirs to remove.
            if (!accountId) throw new Error('Could not find this workspace.');
            const { secrets } = await listAccountSecretResources(accountId, projectId);
            for (const secret of secrets.filter(
              (item) => item.provider_id === 'claude-agent' && item.created_by === data.viewerId,
            )) {
              await deleteAccountSecretResource(accountId, secret.secret_id);
            }
          },
          `${subscription.name} disconnected`,
        );
      }
    },
    [data.accountId, data.viewerId, run, entry, projectId, subscription],
  );

  return { pending, viewerLabel, startSignIn, finishAccess, saveKey, confirm };
}
