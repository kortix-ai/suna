/**
 * One provider's sheet: the web's `ProviderSheet` (provider-sheet.tsx) and
 * `AccountSecretResourcesPanel`, in a terminal.
 *
 * The body follows `providerSheetKind`:
 * - `included`  Kortix's models: nothing to connect.
 * - `pooled-*`  named accounts and keys (flag `pooled_provider_secrets`, on by
 *   default): add one with a label and "Who can use this connection?", then
 *   reconnect, change access, rotate or delete it.
 * - `subscription` / `key` / `no-key`  the project-wide credential flows.
 *
 * Every write goes through `@kortix/sdk`. Key values are captured by hand and
 * drawn as `•`, so a key never reaches the frame buffer.
 */

import {
  type AccountSecretResource,
  type ConnectionAccessChoice,
  type LlmProviderEntry,
  PROVIDER_SUBSCRIPTIONS,
  connectionAccessSummary,
  connectionLabelOwnerName,
  connectionNeedsReconnection,
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
import { type KeyEvent, decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { planUsageLines } from '@kortix/cli/src/commands/providers.ts';
import { kortix } from '../../kortix.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import { matchesProvidersBinding as is } from './keys.ts';
import {
  type ProviderRow,
  accessLine,
  accountsFor,
  formatTokens,
  providerMeta,
  providerSheetKind,
} from './providers-model.ts';
import type { ProvidersData } from './use-providers.ts';
import { type SignInTarget, useSignIn } from './use-sign-in.ts';

export interface ProviderSheetProps {
  projectId: string;
  entry: LlmProviderEntry;
  row: ProviderRow;
  data: ProvidersData;
  focused: boolean;
  width: number;
  height: number;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** True while the sheet owns every key (an input, a confirm, a sign-in). */
  onBusy(busy: boolean): void;
}

type AccountMode = 'oauth' | 'key';

type Flow =
  | { kind: 'view' }
  | {
      kind: 'key';
      fields: string[];
      index: number;
      values: Record<string, string>;
      purpose: 'project' | 'account-new' | 'account-rotate';
      label?: string;
      access?: { choice: ConnectionAccessChoice; memberIds: string[] };
      secret?: AccountSecretResource;
    }
  | { kind: 'confirm'; action: 'remove-key' | 'disconnect' | 'delete-account'; secret?: AccountSecretResource }
  | { kind: 'label'; mode: AccountMode; value: string }
  | {
      kind: 'access';
      purpose: 'create' | 'manage';
      mode: AccountMode;
      label: string;
      choice: ConnectionAccessChoice;
      secret?: AccountSecretResource;
    }
  | {
      kind: 'members';
      purpose: 'create' | 'manage';
      mode: AccountMode;
      label: string;
      selected: string[];
      cursor: number;
      secret?: AccountSecretResource;
    }
  | { kind: 'signin'; code: string; reconnecting?: string };

const VIEW: Flow = { kind: 'view' };

// Keys inside one frame run before React renders: every edit reads the flow it changes.
const editField =
  (change: (value: string) => string) =>
  (flow: Flow): Flow => {
    if (flow.kind !== 'key') return flow;
    const field = flow.fields[flow.index]!;
    return { ...flow, values: { ...flow.values, [field]: change(flow.values[field] ?? '') } };
  };
const editCode =
  (change: (code: string) => string) =>
  (flow: Flow): Flow =>
    flow.kind === 'signin' ? { ...flow, code: change(flow.code) } : flow;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A printable character from a key event, or null. */
function printable(key: KeyEvent): string | null {
  if (key.ctrl || key.option || key.meta || !key.sequence || key.sequence.length !== 1) return null;
  const code = key.sequence.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f ? key.sequence : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ProviderSheet({
  projectId,
  entry,
  row,
  data,
  focused,
  width,
  height,
  onToast,
  onBusy,
}: ProviderSheetProps) {
  const sheet = providerSheetKind(entry, data.pooled && Boolean(data.accountId));
  const subscription = PROVIDER_SUBSCRIPTIONS[entry.id];
  const signIn = useSignIn(projectId);
  const [flow, setFlowState] = useState<Flow>(VIEW);
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState<string | null>(null);

  const setFlow = useCallback(
    (next: Flow) => {
      setFlowState(next);
      onBusy(next.kind !== 'view');
    },
    [onBusy],
  );
  useEffect(() => () => onBusy(false), [onBusy]);

  // ── What is connected ────────────────────────────────────────────────────
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
      (await refreshAccountSecretUsage(data.accountId!, secret.secret_id).catch(() => null))?.usage ?? null,
    ] as const))),
    enabled: oauthMode === 'oauth' && Boolean(data.accountId) && accounts.length > 0,
    refetchInterval: 60_000,
  });

  // ── Writes ───────────────────────────────────────────────────────────────
  const run = useCallback(
    async (label: string, work: () => Promise<unknown>, done: string, expect?: string) => {
      setPending(label);
      try {
        await work();
        await data.refresh(expect);
        onToast(done);
        setFlow(VIEW);
      } catch (error) {
        onToast(errorText(error, `${label} failed.`), 'error');
      } finally {
        setPending(null);
      }
    },
    [data, onToast, setFlow],
  );

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
            if (!accountId) throw new Error('Could not find this project’s account.');
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

  // A pasted key or Claude code arrives as one bracketed paste, not as keys.
  usePaste((event) => {
    if (!focused || pending) return;
    const text = decodePasteBytes(event.bytes).replace(/[\r\n]+/g, '').trim();
    if (!text) return;
    if (flow.kind === 'key') return setFlowState(editField((value) => value + text));
    if (flow.kind === 'signin' && subscription?.kind === 'claude' && signIn.state.phase === 'waiting') {
      setFlowState(editCode((code) => code + text));
    }
  });

  // ── Keys ─────────────────────────────────────────────────────────────────
  useKeyboard((key) => {
    if (!focused || pending) return;

    if (flow.kind === 'signin') {
      const state = signIn.state;
      if (is(key, 'providers.cancel')) {
        signIn.cancel();
        setFlow(VIEW);
        return;
      }
      if (state.url && is(key, 'providers.openLink')) {
        void openUrl(state.url).then(
          () => onToast(`Opened ${hostOf(state.url!)}`),
          () => onToast('Could not open the browser. Press c to copy the link.', 'error'),
        );
        return;
      }
      if (state.url && state.code !== null && is(key, 'providers.copy')) {
        void copyToClipboard(state.code ?? state.url).then((result) =>
          onToast(result.ok ? 'Code copied' : `Copy failed: ${result.error ?? 'no clipboard tool'}`, result.ok ? 'info' : 'error'),
        );
        return;
      }
      if (state.url && state.code === null && is(key, 'providers.copy') && !flow.code) {
        void copyToClipboard(state.url).then((result) =>
          onToast(result.ok ? 'Link copied' : `Copy failed: ${result.error ?? 'no clipboard tool'}`, result.ok ? 'info' : 'error'),
        );
        return;
      }
      if (state.phase === 'idle' && state.error && is(key, 'providers.submit')) {
        setFlow(VIEW);
        return;
      }
      // Claude: the pasted code. Device flows read nothing here.
      if (subscription?.kind === 'claude' && state.phase === 'waiting') {
        if (is(key, 'providers.submit')) return void signIn.submitCode(flow.code);
        if (key.name === 'backspace') return setFlowState(editCode((code) => code.slice(0, -1)));
        const char = printable(key);
        if (char && !(char === 'c' && !flow.code) && !(char === 'o' && !flow.code)) {
          setFlowState(editCode((code) => code + char));
        }
      }
      return;
    }

    if (flow.kind === 'key') {
      if (is(key, 'providers.cancel')) return setFlow(VIEW);
      const field = flow.fields[flow.index]!;
      const value = flow.values[field] ?? '';
      if (is(key, 'providers.submit')) {
        if (!value.trim()) return;
        if (flow.index < flow.fields.length - 1) return setFlowState({ ...flow, index: flow.index + 1 });
        return saveKey(flow);
      }
      if (key.name === 'backspace') return setFlowState(editField((text) => text.slice(0, -1)));
      const char = printable(key);
      if (char) setFlowState(editField((text) => text + char));
      return;
    }

    if (flow.kind === 'confirm') {
      if (is(key, 'providers.cancel')) return setFlow(VIEW);
      if (is(key, 'providers.confirm')) confirm(flow);
      return;
    }

    if (flow.kind === 'label') {
      // The `<input>` owns typing; Esc is ours.
      if (is(key, 'providers.cancel')) setFlow(VIEW);
      return;
    }

    if (flow.kind === 'access') {
      if (is(key, 'providers.cancel')) return setFlow(VIEW);
      const choices: ConnectionAccessChoice[] =
        flow.purpose === 'manage' ? ['project', 'members'] : ['private', 'project', 'members'];
      const index = choices.indexOf(flow.choice);
      const pick = (choice: ConnectionAccessChoice) => {
        if (choice !== 'private' && !canShare) return;
        setFlowState({ ...flow, choice });
      };
      if (is(key, 'providers.down')) return pick(choices[Math.min(index + 1, choices.length - 1)]!);
      if (is(key, 'providers.up')) return pick(choices[Math.max(index - 1, 0)]!);
      const digit = Number(key.name);
      if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) return pick(choices[digit - 1]!);
      if (is(key, 'providers.submit')) {
        if (flow.choice === 'members') {
          const selected = flow.secret?.granted_user_ids ?? [];
          return setFlowState({
            kind: 'members',
            purpose: flow.purpose,
            mode: flow.mode,
            label: flow.label,
            selected,
            cursor: 0,
            secret: flow.secret,
          });
        }
        finishAccess(flow, flow.choice, []);
      }
      return;
    }

    if (flow.kind === 'members') {
      const others = data.members.filter((member) => member.userId !== data.viewerId);
      if (is(key, 'providers.cancel')) return setFlow(VIEW);
      if (is(key, 'providers.down')) return setFlowState({ ...flow, cursor: Math.min(flow.cursor + 1, others.length - 1) });
      if (is(key, 'providers.up')) return setFlowState({ ...flow, cursor: Math.max(flow.cursor - 1, 0) });
      if (is(key, 'providers.mark')) {
        const id = others[flow.cursor]?.userId;
        if (!id) return;
        const selected = flow.selected.includes(id) ? flow.selected.filter((x) => x !== id) : [...flow.selected, id];
        return setFlowState({ ...flow, selected });
      }
      if (is(key, 'providers.submit')) finishAccess(flow, 'members', flow.selected);
      return;
    }

    // ── View ──
    if (is(key, 'providers.toggle')) {
      if (row.status === 'none' || !data.canWrite || (isDefault && enabled)) {
        if (isDefault && enabled) onToast('Choose a project default from another provider before disabling this provider.', 'error');
        return;
      }
      void data
        .setProviderEnabled(entry.id, !enabled)
        .then(() => onToast(`${entry.label} ${enabled ? 'turned off' : 'turned on'} for this project`))
        .catch((error: unknown) => onToast(errorText(error, 'Could not update provider access.'), 'error'));
      return;
    }

    if (sheet === 'pooled-chatgpt' || sheet === 'pooled-claude' || sheet === 'pooled-key') {
      if (is(key, 'providers.down')) return setCursor((value) => Math.min(value + 1, Math.max(rows.length - 1, 0)));
      if (is(key, 'providers.up')) return setCursor((value) => Math.max(value - 1, 0));
      if (is(key, 'providers.add')) {
        return setFlow({ kind: 'label', mode: oauthMode, value: oauthMode === 'oauth' ? viewerLabel() : '' });
      }
      if (sheet === 'pooled-claude' && is(key, 'providers.key')) {
        return setFlow({ kind: 'label', mode: 'key', value: '' });
      }
      if (!current) return;
      const mine = current.created_by === data.viewerId;
      const manageable = mine || ['owner', 'admin'].includes(
        data.members.find((member) => member.userId === data.viewerId)?.accountRole ?? '',
      );
      if (is(key, 'providers.reconnect') && !currentIsKey && mine) {
        return void startSignIn({ resourceId: current.secret_id }, current.label);
      }
      if (is(key, 'providers.access') && manageable && canShare) {
        return setFlow({
          kind: 'access',
          purpose: 'manage',
          mode: currentIsKey ? 'key' : 'oauth',
          label: current.label,
          choice: current.access_mode,
          secret: current,
        });
      }
      if (is(key, 'providers.rotate') && currentIsKey && manageable) {
        return setFlow({
          kind: 'key',
          fields: [current.name],
          index: 0,
          values: {},
          purpose: 'account-rotate',
          secret: current,
        });
      }
      if (is(key, 'providers.delete') && manageable) {
        return setFlow({ kind: 'confirm', action: 'delete-account', secret: current });
      }
      return;
    }

    if (sheet === 'subscription' || sheet === 'key') {
      if (sheet === 'subscription' && is(key, 'providers.signIn') && !signedIn) {
        return void startSignIn({});
      }
      if (is(key, 'providers.key') && data.canWrite) {
        return setFlow({ kind: 'key', fields: entry.envVars, index: 0, values: {}, purpose: 'project' });
      }
      if (is(key, 'providers.delete')) {
        if (sheet === 'subscription' && signedIn) return setFlow({ kind: 'confirm', action: 'disconnect' });
        if (keyConnected && data.canWrite) return setFlow({ kind: 'confirm', action: 'remove-key' });
      }
      if (sheet === 'subscription' && is(key, 'providers.rotate') && keyConnected && data.canWrite) {
        return setFlow({ kind: 'confirm', action: 'remove-key' });
      }
    }
  });

  // ── Render ───────────────────────────────────────────────────────────────
  const inner = Math.max(width - 1, 8);
  const lines: { text: string; fg?: string }[] = [];
  const push = (text: string, fg?: string) => lines.push({ text, fg });
  let hint = 'Esc back';

  const statusWord = row.status === 'included' ? 'Included' : row.status === 'connected' ? 'Connected' : 'Not connected';
  push(layoutRow(entry.label, statusWord, inner), row.status === 'none' ? theme.fg : theme.ok);
  push(providerMeta(row), theme.faint);
  push('');

  if (flow.kind === 'signin') {
    const state = signIn.state;
    const name = subscription?.name ?? entry.label;
    push(flow.reconnecting ? `Reconnect ${flow.reconnecting}` : `Signing in with ${name}`);
    if (state.error) push(state.error, theme.danger);
    if (state.phase === 'starting') push(subscription?.kind === 'claude' ? 'Opening Claude…' : 'Starting sign-in…', theme.faint);
    if (state.phase === 'finishing') push('Signed in. Saving your account…', theme.faint);
    if (state.url && state.code !== null && state.phase === 'waiting') {
      push('Your sign-in code', theme.faint);
      push(`  ${state.code}`, theme.brand);
      push('');
      push(`1. Open the link and sign in to ${name}`);
      push(`   ${state.url}`, theme.faint);
      push('2. Enter the code above');
      push('3. Come back here. This page updates by itself.');
      push('');
      push('Waiting for you to finish in the browser', theme.faint);
      hint = `o open ${hostOf(state.url)} · c copy code · Esc cancel`;
    } else if (state.url && state.phase !== 'finishing') {
      push('Sign in with the Claude account that has your plan, approve the request,');
      push('and paste the code Claude shows you.');
      push(`  ${state.url}`, theme.faint);
      push('');
      push('Code from claude.com', theme.faint);
      push(`▌${flow.code}`, theme.fg);
      if (state.phase === 'checking') push('Connecting…', theme.faint);
      hint = flow.code ? 'Enter connect · Esc cancel' : 'o open claude.com · c copy link · paste the code · Esc cancel';
    } else if (state.phase === 'idle' && state.error) {
      hint = 'Enter back · Esc back';
    }
  } else if (flow.kind === 'key') {
    const title =
      flow.purpose === 'account-rotate' ? `Rotate ${flow.secret?.label ?? ''}` : flow.purpose === 'account-new' ? `Add key · ${entry.label}` : 'API key';
    push(title);
    push(
      flow.purpose === 'account-rotate'
        ? 'Choose who can use this key. Its value is never shown again.'
        : 'Stored encrypted. Kortix never shows it again.',
      theme.faint,
    );
    flow.fields.forEach((field, index) => {
      const value = flow.values[field] ?? '';
      const active = index === flow.index;
      push(`${active ? '▌' : ' '} ${field}  ${'•'.repeat(Math.min(value.length, inner - field.length - 4))}`, active ? theme.fg : theme.faint);
    });
    if (entry.helpUrl) push(`Get a key from ${entry.label}: ${entry.helpUrl}`, theme.faint);
    hint = flow.index < flow.fields.length - 1 ? 'Enter next field · Esc cancel' : 'Enter save key · Esc cancel';
  } else if (flow.kind === 'confirm') {
    if (flow.action === 'delete-account') {
      push(
        currentIsKey ? 'Delete this key for everyone?' : `Delete this ${accountNoun} account for everyone?`,
        theme.danger,
      );
      push(`${flow.secret?.label ?? ''} will be removed from every session pool.`, theme.faint);
    } else if (flow.action === 'disconnect') {
      push(`Disconnect your ${subscription?.plan ?? ''} plan?`, theme.danger);
      push('Sessions stop using it right away. You can sign in again at any time.', theme.faint);
    } else {
      push('Remove key?', theme.danger);
      push(`${entry.label}${entry.models.length ? ` and its ${entry.models.length} models` : ''} stop working in this project.`, theme.faint);
    }
    hint = 'y confirm · Esc cancel';
  } else if (flow.kind === 'access') {
    push(flow.purpose === 'manage' ? `Access to ${flow.label}` : 'Who can use this connection?');
    const choices: { id: ConnectionAccessChoice; label: string; detail: string }[] = [
      ...(flow.purpose === 'create'
        ? [{ id: 'private' as const, label: 'Only you', detail: 'Only you can select it in a session.' }]
        : []),
      { id: 'project', label: 'Everyone in this project', detail: 'Any project member can select it in a session.' },
      {
        id: 'members',
        label: 'Specific members',
        detail: 'Only selected project members and the connection owner can use it.',
      },
    ];
    choices.forEach((choice, index) => {
      const locked = choice.id !== 'private' && !canShare;
      const on = flow.choice === choice.id;
      push(`${on ? '●' : '○'} ${index + 1} ${choice.label}`, locked ? theme.faint : on ? theme.fg : theme.fg);
      push(`    ${choice.detail}`, theme.faint);
    });
    if (!canShare) push('Sharing with others requires permission to manage project secrets.', theme.faint);
    hint = `1-${choices.length} or j/k choose · Enter ${flow.choice === 'members' ? 'pick members' : flow.purpose === 'manage' ? 'save' : 'continue'} · Esc cancel`;
  } else if (flow.kind === 'members') {
    const others = data.members.filter((member) => member.userId !== data.viewerId);
    push('Specific members');
    if (others.length === 0) push('No other members in this project.', theme.faint);
    others.forEach((member, index) => {
      const on = flow.selected.includes(member.userId);
      const pointer = index === flow.cursor ? '›' : ' ';
      push(`${pointer} [${on ? 'x' : ' '}] ${member.email ?? member.userId}`, index === flow.cursor ? theme.fg : theme.faint);
    });
    hint = `Space select · Enter ${flow.purpose === 'manage' ? 'save' : 'continue'} (${flow.selected.length} selected) · Esc cancel`;
  } else if (flow.kind === 'label') {
    // Drawn below with a real `<input>`.
  } else if (sheet === 'included') {
    push(entry.hint, theme.faint);
  } else if (sheet === 'pooled-chatgpt' || sheet === 'pooled-claude' || sheet === 'pooled-key') {
    if (sheet !== 'pooled-key') {
      push(sheet === 'pooled-claude' ? 'Claude accounts' : 'ChatGPT accounts');
      push(
        sheet === 'pooled-claude'
          ? 'Use your Claude Pro or Max plan for Claude models in this project. New accounts are private to you until you share them.'
          : 'Use your ChatGPT Plus or Pro plan in this project. New accounts are private to you until you share them.',
        theme.faint,
      );
    } else {
      push(`${entry.label} API keys`);
    }
    if (rows.length === 0) {
      push(sheet === 'pooled-key' ? 'No keys yet.' : `No ${accountNoun} accounts yet`, theme.faint);
    }
    rows.forEach((secret, index) => {
      const selected = index === Math.min(cursor, rows.length - 1);
      const owner = data.members.find((member) => member.userId === secret.created_by)?.email ?? undefined;
      const summary = connectionAccessSummary(secret, data.viewerId);
      const flags = [
        anthropicKeys.includes(secret) ? 'API key' : null,
        !anthropicKeys.includes(secret) && sheet !== 'pooled-key' && connectionNeedsReconnection(secret) ? 'Needs reconnection' : null,
        // A login with plan usage says "limit reached" and its reset on its own lines.
        !(oauthMode === 'oauth' && (usage.data?.get(secret.secret_id) ?? secret.usage)) &&
        secret.cooldown_until && Date.parse(secret.cooldown_until) > data.accountsReadAt ? 'Cooling down' : null,
        secret.status === 'undecryptable' ? 'Unreadable: reconnect or re-enter' : null,
      ].filter(Boolean);
      push(
        layoutRow(`${selected ? '›' : ' '} ${secret.label}`, accessLine(summary, owner), inner),
        selected ? theme.fg : theme.faint,
      );
      if (flags.length) push(`    ${flags.join(' · ')}`, theme.busy);
      if (oauthMode === 'oauth' && accounts.includes(secret)) {
        for (const line of planUsageLines(usage.data?.get(secret.secret_id) ?? secret.usage)) push(`  ${line}`, theme.faint);
      }
    });
    const actions = [
      'a add',
      sheet === 'pooled-claude' ? 'K add API key' : null,
      current && !currentIsKey && current.created_by === data.viewerId ? 'r reconnect' : null,
      current && canShare ? 'm access' : null,
      current && currentIsKey ? 'x rotate' : null,
      current ? 'd delete' : null,
    ].filter(Boolean);
    hint = `${actions.join(' · ')} · Esc back`;
  } else if (sheet === 'subscription' && subscription) {
    if (!signedIn && !keyConnected) {
      push(`Sign in with ${subscription.name}`, theme.fg);
      push(`  Use your ${subscription.plan} plan. No key to copy.`, theme.faint);
      if (data.canWrite) {
        push('Use an API key', theme.fg);
        push(`  Billed by ${entry.label} per token. Works for every ${entry.label} model.`, theme.faint);
        push('You can connect both. Pick which one a session uses in the model picker.', theme.faint);
      }
    } else {
      push('Connections');
      if (signedIn) push(layoutRow(`  ${subscription.plan} plan`, 'Signed in', inner));
      if (keyConnected) push(layoutRow('  API key', 'Saved key', inner));
    }
    hint = [
      !signedIn ? 's sign in' : 'd disconnect',
      data.canWrite ? (keyConnected ? 'K replace key · x remove key' : 'K API key') : null,
      'Esc back',
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (sheet === 'no-key') {
    push(entry.hint, theme.faint);
  } else {
    if (keyConnected) push(layoutRow(`API key  ${entry.envVars.join(' · ')}`, '••••••••••••', inner));
    else if (data.canWrite) push(`API key  ${entry.envVars.join(' · ')}`, theme.faint);
    else push('Ask an owner of this project to add a key.', theme.faint);
    if (entry.helpUrl) push(`Get a key from ${entry.label}: ${entry.helpUrl}`, theme.faint);
    push('Stored encrypted. Kortix never shows it again.', theme.faint);
    hint = data.canWrite ? (keyConnected ? 'K replace · d remove key · Esc back' : 'K add key · Esc back') : 'Esc back';
  }

  if (flow.kind === 'view' && row.status !== 'none') {
    push('');
    push(
      layoutRow(
        `Enable ${entry.id === 'kortix' ? 'Kortix Managed Models' : entry.label}`,
        data.accessUpdating ? '…' : enabled ? 'on' : 'off',
        inner,
      ),
      enabled ? theme.fg : theme.faint,
    );
    push(
      isDefault && enabled
        ? '  Choose a project default from another provider before disabling this provider.'
        : '  Disable inference without removing credentials.',
      theme.faint,
    );
    if (data.canWrite && !(isDefault && enabled)) hint = `e ${enabled ? 'turn off' : 'turn on'} · ${hint}`;
  }

  if (flow.kind === 'view' && entry.models.length > 0) {
    push('');
    push(row.status === 'none' ? 'What this unlocks' : `${entry.models.length} ${entry.models.length === 1 ? 'model' : 'models'}`);
    const room = Math.max(height - lines.length - 2, 0);
    const shown = entry.models.slice(0, room);
    for (const model of shown) push(layoutRow(`  ${model.name}`, formatTokens(model.limit?.context) ? `${formatTokens(model.limit?.context)} context` : '', inner), row.status === 'none' ? theme.faint : theme.fg);
    if (entry.models.length > shown.length && room > 0) {
      lines.pop();
      push(`  +${entry.models.length - shown.length + 1} more`, theme.faint);
    }
  }

  if (pending) hint = `${pending}…`;

  return (
    <box flexDirection="column" width={width} height={height}>
      {lines.slice(0, Math.max(height - (flow.kind === 'label' ? 4 : 1), 1)).map((line, index) => (
        <text key={index} fg={line.fg ?? theme.fg}>
          {line.text.length > inner ? `${line.text.slice(0, inner - 1)}…` : line.text}
        </text>
      ))}
      {flow.kind === 'label' ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>{flow.mode === 'oauth' ? `Add account · ${accountNoun}` : `Add key · ${entry.label}`}</text>
          <box flexDirection="row" width={width}>
            <text fg={theme.brand}>{'▌'}</text>
            <input
              focused={focused}
              flexGrow={1}
              value={flow.value}
              placeholder={flow.mode === 'oauth' ? `e.g. My ${accountNoun} account` : 'Primary key'}
              onInput={(value: string) => setFlowState({ ...flow, value })}
              onSubmit={() => {
                const label = flow.value.trim();
                if (!label) return;
                setFlowState({ kind: 'access', purpose: 'create', mode: flow.mode, label, choice: 'private' });
              }}
            />
          </box>
          <text fg={theme.faint}>Label · Enter continue · Esc cancel</text>
        </box>
      ) : null}
      <box flexGrow={1} />
      <text fg={theme.faint}>{hint.length > inner ? `${hint.slice(0, inner - 1)}…` : hint}</text>
    </box>
  );
}
