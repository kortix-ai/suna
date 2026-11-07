/**
 * The provider sheet's flow: its modal steps (`key`, `confirm`, `label`,
 * `access`, `members`, `signin`) over the `view`, and the keys that move
 * between them. `provider-sheet.tsx` draws each step; `provider-actions.ts`
 * runs the write a step ends in.
 */

import type { AccountSecretResource, ConnectionAccessChoice } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import type { Dispatch, SetStateAction } from 'react';

import { copyToClipboard } from '../../lib/clipboard.ts';
import { errorText } from '../../lib/errors.ts';
import { printableKey } from '../../lib/keys.ts';
import { openUrl } from '../../lib/open-url.ts';
import { hostOf } from '../../lib/url.ts';
import { type SheetFlow, VIEW } from '../../ui/sheet-flow.ts';
import { matchesProvidersBinding as is } from './keys.ts';
import type { ProviderActions, ProviderConnection } from './provider-actions.ts';
import type { ProviderSheetProps } from './provider-sheet.tsx';
import type { UseSignIn } from './use-sign-in.ts';
export type AccountMode = 'oauth' | 'key';

export type Flow =
  | typeof VIEW
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

export const editField =
  (change: (value: string) => string) =>
  (flow: Flow): Flow => {
    if (flow.kind !== 'key') return flow;
    const field = flow.fields[flow.index]!;
    return { ...flow, values: { ...flow.values, [field]: change(flow.values[field] ?? '') } };
  };
export const editCode =
  (change: (code: string) => string) =>
  (flow: Flow): Flow =>
    flow.kind === 'signin' ? { ...flow, code: change(flow.code) } : flow;

interface ProviderKeysInput
  extends ProviderConnection,
    ProviderActions,
    Omit<SheetFlow<Flow>, 'abort'>,
    Pick<ProviderSheetProps, 'entry' | 'row' | 'data' | 'focused' | 'onToast'> {
  signIn: UseSignIn;
  setCursor: Dispatch<SetStateAction<number>>;
}

/** What each key does in each step. */
export function useProviderKeys({
  entry,
  row,
  data,
  focused,
  pending,
  signIn,
  flow,
  setFlow,
  setFlowState,
  setCursor,
  onToast,
  sheet,
  subscription,
  rows,
  current,
  currentIsKey,
  keyConnected,
  signedIn,
  isDefault,
  enabled,
  canShare,
  oauthMode,
  viewerLabel,
  startSignIn,
  finishAccess,
  saveKey,
  confirm,
}: ProviderKeysInput): void {
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
        const char = printableKey(key);
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
      const char = printableKey(key);
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
        if (isDefault && enabled) onToast('Choose a workspace default from another provider before disabling this provider.', 'error');
        return;
      }
      void data
        .setProviderEnabled(entry.id, !enabled)
        .then(() => onToast(`${entry.label} ${enabled ? 'turned off' : 'turned on'} for this workspace`))
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
}
