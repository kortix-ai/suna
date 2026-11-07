/**
 * The connector sheet's flow: its modal steps (`label`, `rename`, `access`,
 * `pick`, `signin`, `credential`, `confirm`) over the `view`, the account
 * cursor, and the keys that move between them. `connector-sheet.tsx` draws
 * each step; `connector-actions.ts` runs the write a step ends in.
 */

import {
  type AdminConnector,
  type Connection,
  type NewConnectorAccountAudience,
  type NewConnectorAccountDraft,
  connectionSharedWithEveryone,
} from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useCallback, useRef, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard.ts';
import { errorText } from '../../lib/errors.ts';
import { printableKey } from '../../lib/keys.ts';
import { openUrl } from '../../lib/open-url.ts';
import { hostOf } from '../../lib/url.ts';
import { type SheetFlow, VIEW } from '../../ui/sheet-flow.ts';
import { saveAccountCredential } from './account-flows.ts';
import type { ConnectorActions } from './connector-actions.ts';
import type { ConnectorSheetProps } from './connector-sheet.tsx';
import { accessChoices, mayChangeAccount } from './connectors-model.ts';
import { matchesConnectorsBinding as is } from './keys.ts';

export type Flow =
  | typeof VIEW
  | { kind: 'label'; value: string }
  | { kind: 'rename'; connection: Connection; value: string }
  | {
      kind: 'access';
      purpose: 'create' | 'share';
      label: string;
      choice: NewConnectorAccountAudience;
      connection?: Connection;
    }
  | {
      kind: 'pick';
      purpose: 'create' | 'share';
      label: string;
      /** `<kind>:<id>` of each candidate picked. */
      selected: string[];
      cursor: number;
      connection?: Connection;
    }
  | { kind: 'signin'; title: string; url: string | null; code: string | null }
  | { kind: 'credential'; connectionId: string; label: string; value: string; reason?: string }
  | { kind: 'confirm'; action: 'disconnect' | 'remove'; connection?: Connection };

// Keys inside one frame run before React renders: every edit reads the flow it changes.
export const editCredential =
  (change: (value: string) => string) =>
  (flow: Flow): Flow =>
    flow.kind === 'credential' ? { ...flow, value: change(flow.value) } : flow;

/** Picked candidates, split into the draft's three lists. */
export function pickedLists(selected: readonly string[]): NewConnectorAccountDraft['picked'] {
  const ids = (kind: string) => selected.filter((key) => key.startsWith(`${kind}:`)).map((key) => key.slice(kind.length + 1));
  return { memberIds: ids('member'), groupIds: ids('group'), agentIds: ids('agent') };
}

/** The current grants of a shared account, as picker keys. */
function currentPicks(connection: Connection | undefined): string[] {
  if (!connection || connection.owner_type !== 'project' || connectionSharedWithEveryone(connection)) return [];
  return (connection.shared_with ?? []).map((share) => `${share.principal_type}:${share.principal_id}`);
}

/** The selected account. */
export function useAccountCursor(accounts: Connection[]) {
  // The selection follows the account, not its row: setting a default reorders the list.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const current = accounts.find((account) => account.connection_id === cursorId) ?? accounts[0] ?? null;
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const moveCursor = useCallback((delta: number) => {
    setCursorId((previous) => {
      const rows = accountsRef.current;
      if (rows.length === 0) return previous;
      const from = Math.max(
        rows.findIndex((row) => row.connection_id === previous),
        0,
      );
      return rows[Math.min(Math.max(from + delta, 0), rows.length - 1)]!.connection_id;
    });
  }, []);
  return { current, moveCursor };
}

interface ConnectorKeysInput
  extends ConnectorActions,
    SheetFlow<Flow>,
    ReturnType<typeof useAccountCursor>,
    Pick<ConnectorSheetProps, 'projectId' | 'row' | 'data' | 'focused' | 'onToast' | 'onRemoved'> {
  connector: AdminConnector;
  managed: boolean;
  webOnly: boolean;
  webUrl: string;
  openAdd(): void;
}

/** What each key does in each step. */
export function useConnectorKeys({
  projectId,
  row,
  connector,
  data,
  focused,
  managed,
  webOnly,
  webUrl,
  current,
  moveCursor,
  flow,
  setFlow,
  setFlowState,
  abort,
  pending,
  setPending,
  api,
  run,
  submitAdd,
  signInAccount,
  saveShare,
  openAdd,
  onToast,
  onRemoved,
}: ConnectorKeysInput): void {
  useKeyboard((key) => {
    if (!focused || pending) return;

    if (flow.kind === 'signin') {
      if (is(key, 'connectors.cancel')) {
        abort.current?.abort(new Error('cancelled'));
        setFlow(VIEW);
        return;
      }
      if (flow.url && (is(key, 'connectors.openLink') || is(key, 'connectors.submit'))) {
        const url = flow.url;
        void openUrl(url).then(
          () => onToast(`Opened ${hostOf(url)}`),
          () => onToast('Could not open the browser. Press c to copy the link.', 'error'),
        );
        return;
      }
      if (flow.url && is(key, 'connectors.copy')) {
        const value = flow.code ?? flow.url;
        void copyToClipboard(value).then((result) =>
          onToast(
            result.ok ? (flow.code ? 'Code copied' : 'Link copied') : `Copy failed: ${result.error ?? 'no clipboard tool'}`,
            result.ok ? 'info' : 'error',
          ),
        );
      }
      return;
    }

    if (flow.kind === 'credential') {
      if (is(key, 'connectors.cancel')) return setFlow(VIEW);
      if (is(key, 'connectors.submit')) {
        if (!flow.value.trim()) return;
        const { connectionId, label, value } = flow;
        void run('Saving credential', () => saveAccountCredential(projectId, connectionId, value), `Saved as ${label}`);
        return;
      }
      if (key.name === 'backspace') return setFlowState(editCredential((value) => value.slice(0, -1)));
      const char = printableKey(key);
      if (char) setFlowState(editCredential((value) => value + char));
      return;
    }

    if (flow.kind === 'confirm') {
      if (is(key, 'connectors.cancel')) return setFlow(VIEW);
      if (!is(key, 'connectors.confirm')) return;
      if (flow.action === 'remove') {
        setPending('Removing');
        void api
          .remove(connector.slug)
          .then(async () => {
            await data.refresh();
            onToast(`${row.name} removed`);
            setFlow(VIEW);
            onRemoved();
          })
          .catch((error: unknown) => onToast(errorText(error, 'Could not remove the connector.'), 'error'))
          .finally(() => setPending(null));
        return;
      }
      const connection = flow.connection;
      if (connection) void run('Disconnecting', () => api.connections.revoke(connection.connection_id), 'Disconnected');
      return;
    }

    if (flow.kind === 'label' || flow.kind === 'rename') {
      // The `<input>` owns typing; Esc is ours.
      if (is(key, 'connectors.cancel')) setFlow(VIEW);
      return;
    }

    if (flow.kind === 'access') {
      if (is(key, 'connectors.cancel')) return setFlow(VIEW);
      const choices = accessChoices(data.projectName, flow.purpose).map((choice) => choice.id);
      const allowed = (choice: NewConnectorAccountAudience) => choice === 'private' || data.canManageConnections;
      // Functional: two keys inside one frame each move from the choice before them.
      const step = (delta: number) =>
        setFlowState((prev) => {
          if (prev.kind !== 'access') return prev;
          const at = choices.indexOf(prev.choice);
          const choice = choices[Math.min(Math.max(at + delta, 0), choices.length - 1)]!;
          return allowed(choice) ? { ...prev, choice } : prev;
        });
      if (is(key, 'connectors.down')) return step(1);
      if (is(key, 'connectors.up')) return step(-1);
      const digit = Number(key.name);
      if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
        const choice = choices[digit - 1]!;
        if (allowed(choice)) setFlowState((prev) => (prev.kind === 'access' ? { ...prev, choice } : prev));
        return;
      }
      if (is(key, 'connectors.submit')) {
        if (flow.choice === 'members') {
          return setFlowState({
            kind: 'pick',
            purpose: flow.purpose,
            label: flow.label,
            selected: currentPicks(flow.connection),
            cursor: 0,
            connection: flow.connection,
          });
        }
        if (flow.purpose === 'share' && flow.connection) return saveShare(flow.connection, flow.choice, []);
        void submitAdd({ label: flow.label, audience: flow.choice, picked: { memberIds: [], groupIds: [] } });
      }
      return;
    }

    if (flow.kind === 'pick') {
      const candidates = data.candidates;
      if (is(key, 'connectors.cancel')) return setFlow(VIEW);
      const last = Math.max(candidates.length - 1, 0);
      if (is(key, 'connectors.down'))
        return setFlowState((prev) => (prev.kind === 'pick' ? { ...prev, cursor: Math.min(prev.cursor + 1, last) } : prev));
      if (is(key, 'connectors.up'))
        return setFlowState((prev) => (prev.kind === 'pick' ? { ...prev, cursor: Math.max(prev.cursor - 1, 0) } : prev));
      if (is(key, 'connectors.mark')) {
        return setFlowState((prev) => {
          if (prev.kind !== 'pick') return prev;
          const candidate = candidates[prev.cursor];
          if (!candidate) return prev;
          const id = `${candidate.kind}:${candidate.id}`;
          const selected = prev.selected.includes(id) ? prev.selected.filter((x) => x !== id) : [...prev.selected, id];
          return { ...prev, selected };
        });
      }
      if (is(key, 'connectors.submit')) {
        if (flow.purpose === 'share' && flow.connection) return saveShare(flow.connection, 'members', flow.selected);
        void submitAdd({ label: flow.label, audience: 'members', picked: pickedLists(flow.selected) });
      }
      return;
    }

    // ── View ──
    if (is(key, 'connectors.down')) return moveCursor(1);
    if (is(key, 'connectors.up')) return moveCursor(-1);
    if (is(key, 'connectors.add')) return openAdd();
    if (is(key, 'connectors.web')) {
      void openUrl(webUrl).then(
        () => onToast(`Opened ${hostOf(webUrl)}`),
        () => onToast(`Could not open the browser: ${webUrl}`, 'error'),
      );
      return;
    }
    if (is(key, 'connectors.remove')) {
      if (!data.canWrite) return onToast('Removing a connector needs permission to manage the workspace’s connectors.', 'error');
      return setFlow({ kind: 'confirm', action: 'remove' });
    }
    if (!current) return;
    const mayChange = mayChangeAccount(current, data.canManageConnections);
    const active = current.status === 'active';
    if (is(key, 'connectors.copyId')) {
      void copyToClipboard(current.connection_id).then((result) =>
        onToast(result.ok ? 'Connection ID copied to clipboard.' : `Copy failed: ${result.error ?? 'no clipboard tool'}`, result.ok ? 'info' : 'error'),
      );
      return;
    }
    if (!mayChange) {
      if (is(key, 'connectors.rename') || is(key, 'connectors.access') || is(key, 'connectors.disconnect') || is(key, 'connectors.default') || is(key, 'connectors.signIn') || is(key, 'connectors.credential')) {
        onToast('Only the account owner or a connection manager can change this account.', 'error');
      }
      return;
    }
    if (is(key, 'connectors.signIn') && !webOnly && (managed || connector.authSecret)) return void signInAccount(current);
    if (is(key, 'connectors.rename')) return setFlow({ kind: 'rename', connection: current, value: current.label });
    if (is(key, 'connectors.access')) {
      if (current.owner_type === 'member' && !data.canManageConnections) {
        return onToast("Sharing an account needs permission to manage the workspace's connections.", 'error');
      }
      return setFlow({
        kind: 'access',
        purpose: 'share',
        label: current.label,
        choice: current.owner_type === 'project' && !connectionSharedWithEveryone(current) ? 'members' : 'project',
        connection: current,
      });
    }
    if (is(key, 'connectors.default') && !current.is_default && active) {
      const id = current.connection_id;
      void run('Saving default', () => api.connections.setDefault(id), 'Default connection updated');
      return;
    }
    if (is(key, 'connectors.credential') && !managed && !webOnly && connector.authSecret) {
      return setFlow({ kind: 'credential', connectionId: current.connection_id, label: current.label, value: '' });
    }
    if (is(key, 'connectors.disconnect')) return setFlow({ kind: 'confirm', action: 'disconnect', connection: current });
  });
}
