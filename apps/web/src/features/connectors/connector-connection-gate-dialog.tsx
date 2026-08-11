'use client';

import { qk } from '@kortix/sdk/react';
import { CheckIcon as Check, LockIcon as Lock, UsersIcon as Users } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { usePipedreamConnectMember } from '@/hooks/connectors/use-pipedream-connect-member';
import { usePipedreamConnectWorkspace } from '@/hooks/connectors/use-pipedream-connect-workspace';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { type ConnectorGateConnection, useConnectorGateStore } from '@/stores/connector-gate-store';

export function ConnectorConnectionGateContent({
  connections,
  connectedIds,
  pendingId,
  canManageWorkspaceConnections,
  onConnect,
  onCancel,
}: {
  connections: ConnectorGateConnection[];
  connectedIds: ReadonlySet<string>;
  pendingId: string | null;
  canManageWorkspaceConnections: boolean;
  onConnect: (connection: ConnectorGateConnection) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <ModalHeader>
        <ModalTitle className="flex items-center gap-2">
          <Lock className="size-4" />
          Create required connections
        </ModalTitle>
        <ModalDescription>
          {connections.length === 1
            ? 'This session needs one connection.'
            : `This session needs ${connections.length} connections.`}{' '}
          Create every connection before the session starts.
        </ModalDescription>
      </ModalHeader>

      <div className="space-y-2">
        {connections.map((connection) => {
          const connected = connectedIds.has(connection.id);
          const pending = pendingId === connection.id;
          const managerRequired =
            connection.authorization_strategy === 'workspace' && !canManageWorkspaceConnections;
          return (
            <div
              key={connection.id}
              className="border-border/70 bg-muted/20 flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{connection.name}</span>
                  <Badge variant="muted" size="xs">
                    {connection.authorization_strategy === 'user' ? 'Private' : 'Workspace'}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {managerRequired
                    ? 'A workspace manager must create this connection.'
                    : connection.authorization_strategy === 'user'
                      ? 'Only your private sessions can use this connection.'
                      : 'Eligible workspace members can use this connection.'}
                </p>
              </div>

              {connected ? (
                <Badge variant="success" size="sm">
                  <Check className="size-3" />
                  Connected
                </Badge>
              ) : managerRequired ? (
                <Badge variant="warning" size="sm">
                  <Users className="size-3" />
                  Manager required
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  onClick={() => onConnect(connection)}
                  disabled={pendingId !== null}
                  aria-label={`Connect ${connection.name}`}
                >
                  {pending ? <Loading className="size-3.5" /> : <Lock className="size-3.5" />}
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onCancel} disabled={pendingId !== null}>
          Cancel
        </Button>
      </ModalFooter>
    </>
  );
}

function ConnectorConnectionAction({
  workspaceId,
  connection,
  active,
  onPending,
  onConnected,
}: {
  workspaceId: string;
  connection: ConnectorGateConnection;
  active: boolean;
  onPending: (id: string | null) => void;
  onConnected: (id: string) => void;
}) {
  const connected = useCallback(() => onConnected(connection.id), [onConnected, connection.id]);
  const member = usePipedreamConnectMember(workspaceId, connection.slug, connected);
  const workspace = usePipedreamConnectWorkspace(workspaceId, connection.slug, connected);
  const mutation = connection.authorization_strategy === 'user' ? member : workspace;
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    mutation.mutate(undefined, {
      onSettled: () => onPending(null),
    });
  }, [active, mutation, onPending]);

  return null;
}

/**
 * Global gate for a structured `CONNECTOR_CONNECTION_REQUIRED` response.
 */
export function ConnectorConnectionGateDialog() {
  const { isOpen, workspaceId, connectorConnections, retry, closeConnectorGate } =
    useConnectorGateStore();
  const queryClient = useQueryClient();
  const canManageWorkspaceConnections =
    useWorkspaceCan(
      workspaceId ?? undefined,
      WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_CONNECTIONS_MANAGE,
    ).allowed === true;
  const [connectedIds, setConnectedIds] = useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const connectionKey = useMemo(
    () => connectorConnections.map((connection) => connection.id).join(','),
    [connectorConnections],
  );

  useEffect(() => {
    setConnectedIds(new Set());
    setPendingId(null);
  }, [isOpen, connectionKey]);

  const handleConnected = useCallback((id: string) => {
    setConnectedIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isOpen || connectorConnections.length === 0) return;
    if (!connectorConnections.every((connection) => connectedIds.has(connection.id))) return;
    if (workspaceId) {
      void queryClient.invalidateQueries({
        queryKey: ['connections', workspaceId],
      });
      void queryClient.invalidateQueries({
        queryKey: qk.workspace.connectors(workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['session-scope-catalog', workspaceId],
      });
    }
    const run = retry;
    closeConnectorGate();
    run?.();
  }, [
    closeConnectorGate,
    connectedIds,
    connectorConnections,
    isOpen,
    workspaceId,
    queryClient,
    retry,
  ]);

  const activeConnection =
    pendingId === null
      ? null
      : (connectorConnections.find((connection) => connection.id === pendingId) ?? null);

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && closeConnectorGate()}>
      <ModalContent className="lg:max-w-lg">
        <ConnectorConnectionGateContent
          connections={connectorConnections}
          connectedIds={connectedIds}
          pendingId={pendingId}
          canManageWorkspaceConnections={canManageWorkspaceConnections}
          onConnect={(connection) => setPendingId(connection.id)}
          onCancel={closeConnectorGate}
        />
        {activeConnection && workspaceId ? (
          <ConnectorConnectionAction
            workspaceId={workspaceId}
            connection={activeConnection}
            active
            onPending={setPendingId}
            onConnected={handleConnected}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}
