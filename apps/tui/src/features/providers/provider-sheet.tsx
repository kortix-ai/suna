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
  type ConnectionAccessChoice,
  type LlmProviderEntry,
  connectionAccessSummary,
  connectionNeedsReconnection,
} from '@kortix/sdk';
import { useState } from 'react';

import { planAccountText, planUsageLines } from '@kortix/cli/src/commands/providers.ts';
import { hostOf } from '../../lib/url.ts';
import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import { useMaskedPaste, useSheetFlow } from '../../ui/sheet-flow.ts';
import { useProviderActions, useProviderConnection } from './provider-actions.ts';
import { type Flow, editCode, editField, useProviderKeys } from './provider-flow.ts';
import { type ProviderRow, accessLine, formatTokens, providerMeta } from './providers-model.ts';
import type { ProvidersData } from './use-providers.ts';
import { useSignIn } from './use-sign-in.ts';

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
  const signIn = useSignIn(projectId);
  const { flow, setFlow, setFlowState } = useSheetFlow<Flow>(onBusy);
  const [cursor, setCursor] = useState(0);
  const connection = useProviderConnection(projectId, entry, data, cursor);
  const { sheet, subscription, accounts, anthropicKeys, rows, current, currentIsKey } = connection;
  const { keyConnected, signedIn, isDefault, enabled, canShare, oauthMode, accountNoun, usage } = connection;
  const actions = useProviderActions({ projectId, entry, data, connection, signIn, setFlow, onToast });
  const { pending } = actions;

  // A pasted key or Claude code arrives as one bracketed paste, not as keys.
  useMaskedPaste(focused && !pending, (text) => {
    if (flow.kind === 'key') return setFlowState(editField((value) => value + text));
    if (flow.kind === 'signin' && subscription?.kind === 'claude' && signIn.state.phase === 'waiting') {
      setFlowState(editCode((code) => code + text));
    }
  });

  useProviderKeys({ ...connection, ...actions, entry, row, data, focused, signIn, flow, setFlow, setFlowState, setCursor, onToast });

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
      push(`${entry.label}${entry.models.length ? ` and its ${entry.models.length} models` : ''} stop working in this workspace.`, theme.faint);
    }
    hint = 'y confirm · Esc cancel';
  } else if (flow.kind === 'access') {
    push(flow.purpose === 'manage' ? `Access to ${flow.label}` : 'Who can use this connection?');
    const choices: { id: ConnectionAccessChoice; label: string; detail: string }[] = [
      ...(flow.purpose === 'create'
        ? [{ id: 'private' as const, label: 'Only you', detail: 'Only you can select it in a session.' }]
        : []),
      { id: 'project', label: 'Everyone in this workspace', detail: 'Any workspace member can select it in a session.' },
      {
        id: 'members',
        label: 'Specific members',
        detail: 'Only selected workspace members and the connection owner can use it.',
      },
    ];
    choices.forEach((choice, index) => {
      const locked = choice.id !== 'private' && !canShare;
      const on = flow.choice === choice.id;
      push(`${on ? '●' : '○'} ${index + 1} ${choice.label}`, locked ? theme.faint : on ? theme.fg : theme.fg);
      push(`    ${choice.detail}`, theme.faint);
    });
    if (!canShare) push('Sharing with others requires permission to manage workspace secrets.', theme.faint);
    hint = `1-${choices.length} or j/k choose · Enter ${flow.choice === 'members' ? 'pick members' : flow.purpose === 'manage' ? 'save' : 'continue'} · Esc cancel`;
  } else if (flow.kind === 'members') {
    const others = data.members.filter((member) => member.userId !== data.viewerId);
    push('Specific members');
    if (others.length === 0) push('No other members in this workspace.', theme.faint);
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
          ? 'Use your Claude Pro or Max plan for Claude models in this workspace. New accounts are private to you until you share them.'
          : 'Use your ChatGPT Plus or Pro plan in this workspace. New accounts are private to you until you share them.',
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
        !(oauthMode === 'oauth' && (usage.data?.get(secret.secret_id)?.usage ?? secret.usage)) &&
        secret.cooldown_until && Date.parse(secret.cooldown_until) > data.accountsReadAt ? 'Cooling down' : null,
        secret.status === 'undecryptable' ? 'Unreadable: reconnect or re-enter' : null,
      ].filter(Boolean);
      push(
        layoutRow(`${selected ? '›' : ' '} ${secret.label}`, accessLine(summary, owner), inner),
        selected ? theme.fg : theme.faint,
      );
      if (flags.length) push(`    ${flags.join(' · ')}`, theme.busy);
      if (oauthMode === 'oauth' && accounts.includes(secret)) {
        const live = usage.data?.get(secret.secret_id);
        const who = planAccountText(live?.provider_account ?? secret.provider_account, secret.label);
        if (who) push(`    ${who}`, theme.faint);
        for (const line of planUsageLines(live?.usage ?? secret.usage)) push(`  ${line}`, theme.faint);
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
    else push('Ask an owner of this workspace to add a key.', theme.faint);
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
        ? '  Choose a workspace default from another provider before disabling this provider.'
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
