/**
 * Everything the connector sheet writes through `@kortix/sdk`, and the sign-in
 * it runs in a terminal: a managed app's hosted Connect Link, an MCP server's
 * device code or authorization link, else a masked credential.
 */

import {
  type AdminConnector,
  type Connection,
  type NewConnectorAccountAudience,
  type NewConnectorAccountDraft,
  grantConnectionAccess,
  newConnectorAccountGrantees,
  newConnectorAccountLabelTaken,
  newConnectorAccountReady,
  planConnectionShare,
  planPrivateConnectionShare,
  revokeAssignment,
} from '@kortix/sdk';
import { useCallback } from 'react';

import { kortix } from '../../kortix.ts';
import { errorText } from '../../lib/errors.ts';
import { type SheetFlow, VIEW, useSheetRun } from '../../ui/sheet-flow.ts';
import {
  type SignInIo,
  connectManagedAccount,
  createDirectAccount,
  signInDirectAccount,
} from './account-flows.ts';
import { type Flow, pickedLists } from './connector-flow.ts';
import type { ConnectorSheetProps } from './connector-sheet.tsx';

export type ConnectorActions = ReturnType<typeof useConnectorActions>;

interface ConnectorActionsInput
  extends Omit<SheetFlow<Flow>, 'flow'>,
    Pick<ConnectorSheetProps, 'projectId' | 'row' | 'data' | 'onToast'> {
  connector: AdminConnector;
  accounts: Connection[];
  managed: boolean;
  webUrl: string;
}

/** The writes. Each one ends its flow step: pending, refresh, toast, back to the view. */
export function useConnectorActions({
  projectId,
  row,
  connector,
  accounts,
  managed,
  data,
  webUrl,
  setFlow,
  setFlowState,
  abort,
  onToast,
}: ConnectorActionsInput) {
  const api = kortix().project(projectId).connectors;
  // A failed write may have applied in part: read again either way.
  const { pending, setPending, run } = useSheetRun({ setFlow, onToast, refresh: data.refresh, refreshOnError: true });

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
    [abort, data, onToast, setFlow, setFlowState],
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
            : "Sharing an account needs permission to manage the workspace's connections.",
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
          onToast(draft.audience === 'private' ? 'Connected privately — only you can use this' : 'Workspace connection created');
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
    [accounts, afterDirect, connector, data, managed, onToast, projectId, returnUrl, row.name, setFlow, setPending, signIn],
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
      if (!accountId) return onToast('Could not find this workspace.', 'error');
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

  return { api, pending, setPending, run, submitAdd, signInAccount, saveShare };
}
