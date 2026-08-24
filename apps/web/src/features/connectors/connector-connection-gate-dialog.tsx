'use client';

import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react';
import { CheckIcon as Check, LockIcon as Lock, UsersIcon as Users } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

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
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { type ConnectorGateConnection, useConnectorGateStore } from '@/stores/connector-gate-store';

export function ConnectorConnectionGateContent({
  connections,
  connectedIds,
  pendingId,
  canManageProjectConnections,
  onConnect,
  renderConnectAction,
  onCancel,
}: {
  connections: ConnectorGateConnection[];
  connectedIds: ReadonlySet<string>;
  pendingId: string | null;
  canManageProjectConnections: boolean;
  onConnect: (connection: ConnectorGateConnection) => void;
  renderConnectAction?: (
    connection: ConnectorGateConnection,
    pending: boolean,
    disabled: boolean,
  ) => ReactNode;
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
            connection.authorization_strategy === 'project' && !canManageProjectConnections;
          return (
            <div
              key={connection.id}
              className="border-border/70 bg-muted/20 flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{connection.name}</span>
                  <Badge variant="muted" size="xs">
                    {connection.authorization_strategy === 'user' ? 'Private' : 'Project'}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {managerRequired
                    ? 'A project manager must create this connection.'
                    : connection.authorization_strategy === 'user'
                      ? 'Only your private sessions can use this connection.'
                      : 'Eligible project members can use this connection.'}
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
              ) : renderConnectAction ? (
                renderConnectAction(connection, pending, pendingId !== null)
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
  projectId,
  connection,
  pending,
  disabled,
  onPending,
  onConnected,
}: {
  projectId: string;
  connection: ConnectorGateConnection;
  pending: boolean;
  disabled: boolean;
  onPending: (id: string | null) => void;
  onConnected: (id: string) => void;
}) {
  const connected = useCallback(() => onConnected(connection.id), [onConnected, connection.id]);
  const member = usePipedreamConnectMember(projectId, connection.slug, connected);
  const project = usePipedreamConnectProject(projectId, connection.slug, connected);
  const mutation = connection.authorization_strategy === 'user' ? member : project;

  return (
    <Button
      size="sm"
      variant="outline"
      className="shrink-0 gap-1.5"
      onClick={() => {
        onPending(connection.id);
        mutation.mutate(undefined, { onSettled: () => onPending(null) });
      }}
      disabled={disabled}
      aria-label={`Connect ${connection.name}`}
    >
      {pending ? <Loading className="size-3.5" /> : <Lock className="size-3.5" />}
      Connect
    </Button>
  );
}

/**
 * Global gate for a structured `CONNECTOR_CONNECTION_REQUIRED` response.
 */
export function ConnectorConnectionGateDialog() {
  const { isOpen, projectId, connectorConnections, retry, closeConnectorGate } =
    useConnectorGateStore();
  const queryClient = useQueryClient();
  const canManageProjectConnections =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE)
      .allowed === true;
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
    if (projectId) {
      void queryClient.invalidateQueries({
        queryKey: ['connections', projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: qk.project.connectors(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['session-scope-catalog', projectId],
      });
    }
    const run = retry;
    closeConnectorGate();
    run?.();
  }, [closeConnectorGate, connectedIds, connectorConnections, isOpen, projectId, queryClient, retry]);

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && closeConnectorGate()}>
      <ModalContent className="lg:max-w-lg">
        <ConnectorConnectionGateContent
          connections={connectorConnections}
          connectedIds={connectedIds}
          pendingId={pendingId}
          canManageProjectConnections={canManageProjectConnections}
          onConnect={(connection) => setPendingId(connection.id)}
          renderConnectAction={(connection, pending, disabled) =>
            projectId ? (
              <ConnectorConnectionAction
                key={connection.id}
                projectId={projectId}
                connection={connection}
                pending={pending}
                disabled={disabled}
                onPending={setPendingId}
                onConnected={handleConnected}
              />
            ) : null
          }
          onCancel={closeConnectorGate}
        />
      </ModalContent>
    </Modal>
  );
}
