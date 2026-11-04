/**
 * One project connector's sheet: the web connector page's Accounts list
 * (`ConnectionsList`) in a terminal.
 *
 * Each account states who may use it ("Only you", "Everyone in project", or
 * names) and what is missing ("Not signed in", "Credential rejected"). The
 * actions are the web row's: Add account (a name, then "Who can use it"),
 * Connect / reconnect, Rename, Share (who can use it), Use by default, Set
 * credential, Disconnect, Copy connection ID, and Remove for the connector.
 *
 * Sign-in in a terminal: a managed app prints its hosted Connect Link (`o`
 * opens the browser, `c` copies) and polls finalize every 2 s for up to 10
 * minutes; an MCP server with one-click OAuth shows a device code, or its
 * authorization link; anything else takes a masked credential.
 *
 * Every write goes through `@kortix/sdk`. A credential is captured by hand and
 * drawn as `•`, so it never reaches the frame buffer.
 */

import {
  type Connection,
  type NewConnectorAccountAudience,
  type NewConnectorAccountDraft,
  connectionSharedWithEveryone,
  connectorProviderLabel,
  newConnectorAccountGrantees,
  newConnectorAccountLabelTaken,
  newConnectorAccountReady,
  planConnectionShare,
  planPrivateConnectionShare,
  proposeConnectorAccountLabel,
  revokeAssignment,
  grantConnectionAccess,
} from '@kortix/sdk';
import { type KeyEvent, decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { printable } from '../../lib/printable.ts';
import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import {
  type SignInIo,
  connectManagedAccount,
  createDirectAccount,
  isManaged,
  saveAccountCredential,
  signInDirectAccount,
} from './account-flows.ts';
import {
  type ProjectConnectorRow,
  TONE_WORD,
  accessChoices,
  accountAudience,
  accountFlags,
  connectorMeta,
  connectorWebPath,
  mayChangeAccount,
} from './connectors-model.ts';
import { matchesConnectorsBinding as is } from './keys.ts';
import type { ConnectorsData } from './use-connectors.ts';

export interface ConnectorSheetProps {
  projectId: string;
  row: ProjectConnectorRow;
  data: ConnectorsData;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  /** Open "Add account" once, right after Install added the profile. */
  addRequest: boolean;
  onAddRequestHandled(): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** True while the sheet owns every key (an input, a confirm, a sign-in). */
  onBusy(busy: boolean): void;
  /** The connector was removed from the project. */
  onRemoved(): void;
}

type Flow =
  | { kind: 'view' }
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

const VIEW: Flow = { kind: 'view' };

// Keys inside one frame run before React renders: every edit reads the flow it changes.
const editCredential =
  (change: (value: string) => string) =>
  (flow: Flow): Flow =>
    flow.kind === 'credential' ? { ...flow, value: change(flow.value) } : flow;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A printable character from a key event, or null. */
function typed(key: KeyEvent): string | null {
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

/** Picked candidates, split into the draft's three lists. */
function pickedLists(selected: readonly string[]): NewConnectorAccountDraft['picked'] {
  const ids = (kind: string) => selected.filter((key) => key.startsWith(`${kind}:`)).map((key) => key.slice(kind.length + 1));
  return { memberIds: ids('member'), groupIds: ids('group'), agentIds: ids('agent') };
}

/** The current grants of a shared account, as picker keys. */
function currentPicks(connection: Connection | undefined): string[] {
  if (!connection || connection.owner_type !== 'project' || connectionSharedWithEveryone(connection)) return [];
  return (connection.shared_with ?? []).map((share) => `${share.principal_type}:${share.principal_id}`);
}

export function ConnectorSheet({
  projectId,
  row,
  data,
  focused,
  width,
  height,
  webBaseUrl,
  addRequest,
  onAddRequestHandled,
  onToast,
  onBusy,
  onRemoved,
}: ConnectorSheetProps) {
  const connector = row.connector;
  const accounts = row.accounts;
  const managed = isManaged(connector);
  // Channels (Slack, Telegram, email inboxes) and computers connect on their own pages.
  const webOnly = connector.provider === 'channel' || connector.provider === 'computer';
  const [flow, setFlowState] = useState<Flow>(VIEW);
  // The selection follows the account, not its row: setting a default reorders the list.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const setFlow = useCallback(
    (next: Flow) => {
      setFlowState(next);
      onBusy(next.kind !== 'view');
    },
    [onBusy],
  );
  useEffect(
    () => () => {
      abort.current?.abort(new Error('cancelled'));
      onBusy(false);
    },
    [onBusy],
  );

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
  const webUrl = `${webBaseUrl.replace(/\/$/, '')}${connectorWebPath(projectId, connector.slug)}`;
  const api = kortix().project(projectId).connectors;

  // ── Writes ───────────────────────────────────────────────────────────────
  const run = useCallback(
    async (label: string, work: () => Promise<unknown>, done: string) => {
      setPending(label);
      try {
        await work();
        await data.refresh();
        onToast(done);
        setFlow(VIEW);
      } catch (error) {
        await data.refresh();
        onToast(errorText(error, `${label} failed.`), 'error');
      } finally {
        setPending(null);
      }
    },
    [data, onToast, setFlow],
  );

  /**
   * Run one sign-in. The flow shows the link once the SDK hands it over; Esc
   * aborts it. Resolves with what to do next, or null when it failed or was
   * cancelled.
   */
  const signIn = useCallback(
    async <T,>(title: string, work: (io: SignInIo) => Promise<T>): Promise<T | null> => {
      abort.current?.abort(new Error('cancelled'));
      const controller = new AbortController();
      abort.current = controller;
      setFlow({ kind: 'signin', title, url: null, code: null });
      try {
        const result = await work({
          signal: controller.signal,
          show: ({ url, code }) =>
            setFlowState((flow) => (flow.kind === 'signin' ? { ...flow, url, code: code ?? null } : flow)),
        });
        return result;
      } catch (error) {
        if (!controller.signal.aborted) onToast(errorText(error, 'Could not connect the account. Try again.'), 'error');
        return null;
      } finally {
        if (abort.current === controller) abort.current = null;
        await data.refresh();
      }
    },
    [data, onToast, setFlow],
  );

  const afterDirect = useCallback(
    (next: Awaited<ReturnType<typeof signInDirectAccount>> | null, label: string, done: string) => {
      if (!next) return setFlow(VIEW);
      if (next.kind === 'credential') {
        if (next.reason) onToast(`Could not start the ${row.name} sign-in: ${next.reason}`, 'error');
        return setFlow({ kind: 'credential', connectionId: next.connectionId, label, value: '' });
      }
      onToast(done);
      setFlow(VIEW);
    },
    [onToast, row.name, setFlow],
  );

  const returnUrl = webUrl;

  /** Add account: the draft is complete (a name and who can use it). */
  const submitAdd = useCallback(
    async (draft: NewConnectorAccountDraft) => {
      if (newConnectorAccountLabelTaken(draft, accounts)) {
        onToast(`An account named ${draft.label.trim()} already exists.`, 'error');
        return;
      }
      if (!newConnectorAccountReady(draft, accounts, { canManageConnections: data.canManageConnections, accountId: data.accountId })) {
        onToast(
          draft.audience === 'members'
            ? 'Pick at least one person, group, or agent.'
            : "Sharing an account needs permission to manage the project's connections.",
          'error',
        );
        return;
      }
      if (managed) {
        const ok = await signIn(`Connect ${draft.label}`, async (io) => {
          await connectManagedAccount(
            projectId,
            connector,
            {
              label: draft.label,
              owner: draft.audience === 'private' ? 'me' : 'project',
              grantees: draft.audience === 'members' ? newConnectorAccountGrantees(draft.picked) : undefined,
              accountId: data.accountId,
            },
            io,
          );
          return true;
        });
        if (ok) {
          onToast(draft.audience === 'private' ? 'Connected privately — only you can use this' : 'Project connection created');
          setFlow(VIEW);
        } else setFlow(VIEW);
        return;
      }
      setPending('Adding account');
      let connection: Connection;
      try {
        connection = await createDirectAccount(projectId, connector, row.name, draft, data.accountId);
      } catch (error) {
        await data.refresh();
        onToast(errorText(error, 'Could not add the account.'), 'error');
        setPending(null);
        return;
      }
      setPending(null);
      const next = await signIn(`Connect ${draft.label}`, (io) =>
        signInDirectAccount(projectId, connector, connection.connection_id, returnUrl, io),
      );
      afterDirect(next, connection.label, `Saved as ${connection.label}`);
    },
    [accounts, afterDirect, connector, data, managed, onToast, projectId, returnUrl, row.name, setFlow, signIn],
  );

  /** Connect an account that is not signed in, or reconnect one. */
  const signInAccount = useCallback(
    async (connection: Connection) => {
      const owner = connection.owner_type === 'project' ? 'project' : 'me';
      if (managed) {
        const ok = await signIn(`Connect ${connection.label}`, async (io) => {
          // Reconciling the SAME label re-points this row, never a second account.
          await connectManagedAccount(projectId, connector, { label: connection.label, owner, accountId: data.accountId }, io);
          return true;
        });
        if (ok) onToast(`${connection.label} connected`);
        setFlow(VIEW);
        return;
      }
      const next = await signIn(`Connect ${connection.label}`, (io) =>
        signInDirectAccount(projectId, connector, connection.connection_id, returnUrl, io),
      );
      afterDirect(next, connection.label, `${connection.label} connected`);
    },
    [afterDirect, connector, data.accountId, managed, onToast, projectId, returnUrl, setFlow, signIn],
  );

  /** Share: who can use an existing account. Grants first, then revokes. */
  const saveShare = useCallback(
    (connection: Connection, audience: NewConnectorAccountAudience, selected: string[]) => {
      const accountId = data.accountId;
      if (!accountId) return onToast('Could not find this project’s account.', 'error');
      const picked = pickedLists(selected);
      if (audience === 'members' && picked.memberIds.length + picked.groupIds.length + (picked.agentIds?.length ?? 0) === 0) {
        return onToast('Pick at least one person, group, or agent.', 'error');
      }
      if (connection.owner_type === 'member') {
        const viewerId = data.viewerId ?? '';
        const principals =
          audience === 'project' ? [] : planPrivateConnectionShare({ ...picked, everyone: false }, true, viewerId);
        if (!principals) return setFlow(VIEW);
        void run('Saving access', () => api.connections.share(connection.connection_id, principals), 'Access updated');
        return;
      }
      const current = connection.shared_with ?? [];
      // Every current grant is up for removal; a picked one is kept (`planConnectionShare`).
      const removed = new Set(current.map((grant) => grant.grant_id));
      const plan = planConnectionShare(current, removed, audience === 'project' ? { memberIds: [], groupIds: [] } : picked, projectId);
      void run(
        'Saving access',
        async () => {
          await grantConnectionAccess(accountId, projectId, connection.connection_id, plan.add);
          await Promise.all(plan.revoke.map((id) => revokeAssignment(accountId, id)));
        },
        'Access updated',
      );
    },
    [api.connections, data.accountId, data.viewerId, onToast, projectId, run, setFlow],
  );

  const openAdd = useCallback(() => {
    if (webOnly) {
      onToast(`Add a ${row.name} account in the web app: press w.`, 'error');
      return;
    }
    setFlow({ kind: 'label', value: proposeConnectorAccountLabel(row.name, accounts.map((account) => account.label)) });
  }, [accounts, onToast, row.name, setFlow, webOnly]);

  // Install hands over with "Add account" open, once.
  useEffect(() => {
    if (!addRequest) return;
    onAddRequestHandled();
    openAdd();
  }, [addRequest, onAddRequestHandled, openAdd]);

  // A pasted credential arrives as one bracketed paste, not as keys.
  usePaste((event) => {
    if (!focused || pending || flow.kind !== 'credential') return;
    const text = decodePasteBytes(event.bytes).replace(/[\r\n]+/g, '').trim();
    if (text) setFlowState(editCredential((value) => value + text));
  });

  // ── Keys ─────────────────────────────────────────────────────────────────
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
      const char = typed(key);
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
      if (!data.canWrite) return onToast('Removing a connector needs permission to manage the project’s connectors.', 'error');
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
        return onToast("Sharing an account needs permission to manage the project's connections.", 'error');
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

  // ── Render ───────────────────────────────────────────────────────────────
  const inner = Math.max(width - 1, 8);
  const lines: { text: string; fg?: string }[] = [];
  const push = (text: string, fg?: string) => lines.push({ text: printable(text), fg });
  let hint = 'Esc back';

  push(layoutRow(row.name, TONE_WORD[row.tone], inner), row.tone === 'connected' ? theme.ok : row.tone === 'error' ? theme.danger : theme.busy);
  push(connectorMeta(row), theme.faint);
  push('');

  if (flow.kind === 'signin') {
    push(flow.title);
    if (!flow.url) {
      push('Starting authorization…', theme.faint);
      hint = 'Esc cancel';
    } else {
      if (flow.code) {
        push('Your sign-in code', theme.faint);
        push(`  ${flow.code}`, theme.brand);
        push('');
        push('1. Open the link and sign in');
        for (const part of chunk(flow.url, inner - 3)) push(`   ${part}`, theme.faint);
        push('2. Enter the code above');
        push('3. Come back here. This page updates by itself.');
      } else {
        push(`Sign in to ${row.name} in the browser, then come back here.`);
        // The whole link, broken over lines: a terminal user can select it.
        for (const part of chunk(flow.url, inner - 2)) push(`  ${part}`, theme.faint);
      }
      push('');
      push('Waiting for authorization…', theme.faint);
      hint = `Enter/o open ${hostOf(flow.url)} · c copy ${flow.code ? 'code' : 'link'} · Esc cancel`;
    }
  } else if (flow.kind === 'credential') {
    push(`Set credential · ${flow.label}`);
    if (flow.reason) push(flow.reason, theme.faint);
    push('Stored encrypted. Kortix never shows it again.', theme.faint);
    const name = connector.authSecret ?? 'Credential';
    push(`▌ ${name}  ${'•'.repeat(Math.min(flow.value.length, Math.max(inner - name.length - 4, 0)))}`);
    hint = 'type or paste · Enter save · Esc cancel';
  } else if (flow.kind === 'confirm') {
    if (flow.action === 'remove') {
      push(`Remove ${row.name}`, theme.danger);
      push('Deletes its accounts and tool rules. Sessions lose access at once.', theme.faint);
    } else {
      push(`Disconnect "${flow.connection?.label ?? ''}"?`, theme.danger);
      push(
        flow.connection?.owner_type === 'project'
          ? 'Everyone on this project loses access to this account. Sessions bound to it will stop working.'
          : 'Your own connection is removed. Sessions bound to it will stop working.',
        theme.faint,
      );
    }
    hint = 'y confirm · Esc cancel';
  } else if (flow.kind === 'access') {
    push(flow.purpose === 'share' ? `Share ${flow.label}` : `Add a ${row.name} account`);
    push(
      flow.purpose === 'share'
        ? flow.connection?.owner_type === 'member'
          ? 'Choose who else can use your account. It becomes a shared account, which the project’s connection managers can also manage.'
          : 'Choose who can use this account.'
        : 'Who can use it',
      theme.faint,
    );
    accessChoices(data.projectName, flow.purpose).forEach((choice, index) => {
      const locked = choice.id !== 'private' && !data.canManageConnections;
      const on = flow.choice === choice.id;
      push(`${on ? '●' : '○'} ${index + 1} ${choice.label}`, locked ? theme.faint : theme.fg);
      push(`    ${choice.detail}`, theme.faint);
    });
    if (!data.canManageConnections) push("Sharing an account needs permission to manage the project's connections.", theme.faint);
    if (flow.purpose === 'create') push("You'll authorize the account in the next step.", theme.faint);
    const n = accessChoices(data.projectName, flow.purpose).length;
    hint = `1-${n} or j/k choose · Enter ${flow.choice === 'members' ? 'pick' : flow.purpose === 'share' ? 'save' : 'continue'} · Esc cancel`;
  } else if (flow.kind === 'pick') {
    push('Specific people, groups, or agents');
    if (data.candidates.length === 0) push('No one else in this project yet.', theme.faint);
    const room = Math.max(height - lines.length - 3, 3);
    const start = Math.min(Math.max(flow.cursor - Math.floor(room / 2), 0), Math.max(data.candidates.length - room, 0));
    data.candidates.slice(start, start + room).forEach((candidate, offset) => {
      const index = start + offset;
      const on = flow.selected.includes(`${candidate.kind}:${candidate.id}`);
      const tag = candidate.kind === 'member' ? 'Member' : candidate.kind === 'group' ? 'Group' : 'Agent';
      push(
        layoutRow(`${index === flow.cursor ? '›' : ' '} [${on ? 'x' : ' '}] ${candidate.label}`, tag, inner),
        index === flow.cursor ? theme.fg : theme.dim,
      );
    });
    hint = `Space select · Enter ${flow.purpose === 'share' ? 'save' : 'continue'} (${flow.selected.length} selected) · Esc cancel`;
  } else if (flow.kind === 'label' || flow.kind === 'rename') {
    // Drawn below with a real `<input>`.
  } else {
    push(accounts.length ? `Accounts · ${accounts.length}` : 'Accounts');
    if (webOnly) push(`${row.name} connects on its page in the web app. Press w.`, theme.faint);
    if (accounts.length === 0) {
      push('No account yet', theme.faint);
      push(`Add an account to use ${row.name} in sessions.`, theme.faint);
    }
    accounts.forEach((connection) => {
      const selected = connection === current;
      const name = `${selected ? '›' : ' '} ${connection.label}${connection.is_default ? ' · Default' : ''}`;
      push(layoutRow(name, accountAudience(connection, data.viewerId), inner), selected ? theme.fg : theme.dim);
      const flags = accountFlags(connection, connector);
      if (flags.length) push(`    ${flags.join(' · ')}`, flags.some((flag) => flag.startsWith('Credential') || flag === 'Error') ? theme.danger : theme.busy);
    });
    push('');
    push(`Runs over ${connectorProviderLabel(connector.provider)}`, theme.faint);
    if (current) {
      const mayChange = mayChangeAccount(current, data.canManageConnections);
      const actions = [
        webOnly ? null : 'a add',
        mayChange && !webOnly && (managed || connector.authSecret) ? 's connect' : null,
        mayChange ? 'n rename' : null,
        mayChange ? 'm share' : null,
        mayChange && !current.is_default && current.status === 'active' ? 'u default' : null,
        mayChange && !managed && !webOnly && connector.authSecret ? 'x credential' : null,
        mayChange ? 'd disconnect' : null,
        'i copy ID',
      ].filter(Boolean);
      hint = `${actions.join(' · ')} · w web · Esc back`;
    } else {
      hint = `${webOnly ? '' : 'a add account · '}w web · Esc back`;
    }
  }

  if (pending) hint = `${pending}…`;
  const inputFlow = flow.kind === 'label' || flow.kind === 'rename' ? flow : null;

  return (
    <box flexDirection="column" width={width} height={height}>
      {lines.slice(0, Math.max(height - (inputFlow ? 5 : 0) - hintLines(hint, inner).length, 1)).map((line, index) => (
        <text key={index} fg={line.fg ?? theme.fg}>
          {line.text.length > inner ? `${line.text.slice(0, inner - 1)}…` : line.text}
        </text>
      ))}
      {inputFlow ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>
            {inputFlow.kind === 'rename' ? `Rename ${inputFlow.connection.label}` : `Add a ${row.name} account`}
          </text>
          <text fg={theme.faint}>
            {inputFlow.kind === 'rename'
              ? 'Only the name changes. The account stays connected, and nobody signs in again.'
              : 'Name the account and choose who can use it.'}
          </text>
          <box flexDirection="row" width={width}>
            <text fg={theme.brand}>{'▌'}</text>
            <input
              focused={focused}
              flexGrow={1}
              value={inputFlow.value}
              placeholder="Name"
              onInput={(value: string) =>
                setFlowState((flow) => (flow.kind === 'label' || flow.kind === 'rename' ? { ...flow, value } : flow))
              }
              onSubmit={() => {
                const label = inputFlow.value.trim();
                if (!label) return;
                if (inputFlow.kind === 'rename') {
                  if (label === inputFlow.connection.label) return setFlow(VIEW);
                  const id = inputFlow.connection.connection_id;
                  void run('Renaming', () => api.connections.rename(id, label), 'Account renamed');
                  return;
                }
                setFlowState({ kind: 'access', purpose: 'create', label, choice: 'private' });
              }}
            />
          </box>
          <text fg={theme.faint}>{inputFlow.kind === 'rename' ? 'Name · Enter save · Esc cancel' : 'Name · Enter continue · Esc cancel'}</text>
        </box>
      ) : null}
      <box flexGrow={1} />
      {hintLines(hint, inner).map((line, index) => (
        <text key={`hint-${index}`} fg={theme.faint}>
          {line}
        </text>
      ))}
    </box>
  );
}

/** `text` in pieces of `width` characters. */
export function chunk(text: string, width: number): string[] {
  const size = Math.max(width, 8);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** The key hint, broken at its ` · ` separators so no action is cut off. */
export function hintLines(hint: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const part of hint.split(' · ')) {
    const next = line ? `${line} · ${part}` : part;
    if (next.length <= width || !line) line = next;
    else {
      out.push(line);
      line = part;
    }
  }
  if (line) out.push(line);
  return out.map((text) => (text.length > width ? `${text.slice(0, width - 1)}…` : text));
}
