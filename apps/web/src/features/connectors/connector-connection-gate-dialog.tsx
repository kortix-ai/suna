'use client';

import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react';
import { CheckIcon as Check, LockIcon as Lock, UsersIcon as Users } from '@phosphor-icons/react';
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
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { type ConnectorGateProfile, useConnectorGateStore } from '@/stores/connector-gate-store';

export function ConnectorAuthorizationGateContent({
  profiles,
  connectedIds,
  pendingId,
  canManageProjectAuthorizations,
  onConnect,
  onCancel,
}: {
  profiles: ConnectorGateProfile[];
  connectedIds: ReadonlySet<string>;
  pendingId: string | null;
  canManageProjectAuthorizations: boolean;
  onConnect: (profile: ConnectorGateProfile) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <ModalHeader>
        <ModalTitle className="flex items-center gap-2">
          <Lock className="size-4" />
          Connect required authorizations
        </ModalTitle>
        <ModalDescription>
          {profiles.length === 1
            ? 'This session needs one connector profile.'
            : `This session needs ${profiles.length} connector profiles.`}{' '}
          Connect every profile before the session starts.
        </ModalDescription>
      </ModalHeader>

      <div className="space-y-2">
        {profiles.map((profile) => {
          const connected = connectedIds.has(profile.id);
          const pending = pendingId === profile.id;
          const managerRequired =
            profile.authorization_strategy === 'project' && !canManageProjectAuthorizations;
          return (
            <div
              key={profile.id}
              className="border-border/70 bg-muted/20 flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{profile.name}</span>
                  <Badge variant="muted" size="xs">
                    {profile.authorization_strategy === 'user' ? 'Private' : 'Project'}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {managerRequired
                    ? 'A project manager must connect this authorization.'
                    : profile.authorization_strategy === 'user'
                      ? 'Only your private sessions can use this authorization.'
                      : 'Eligible project members can use this authorization.'}
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
                  onClick={() => onConnect(profile)}
                  disabled={pendingId !== null}
                  aria-label={`Connect ${profile.name}`}
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

function ConnectorAuthorizationAction({
  projectId,
  profile,
  active,
  onPending,
  onConnected,
}: {
  projectId: string;
  profile: ConnectorGateProfile;
  active: boolean;
  onPending: (id: string | null) => void;
  onConnected: (id: string) => void;
}) {
  const connected = useCallback(() => onConnected(profile.id), [onConnected, profile.id]);
  const member = usePipedreamConnectMember(projectId, profile.slug, connected);
  const project = usePipedreamConnectProject(projectId, profile.slug, connected);
  const mutation = profile.authorization_strategy === 'user' ? member : project;
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
 * Global gate for a structured `CONNECTOR_AUTHORIZATION_REQUIRED` response.
 */
export function ConnectorConnectionGateDialog() {
  const { isOpen, projectId, connectorProfiles, retry, closeConnectorGate } =
    useConnectorGateStore();
  const queryClient = useQueryClient();
  const canManageProjectAuthorizations =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE)
      .allowed === true;
  const [connectedIds, setConnectedIds] = useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const profileKey = useMemo(
    () => connectorProfiles.map((profile) => profile.id).join(','),
    [connectorProfiles],
  );

  useEffect(() => {
    setConnectedIds(new Set());
    setPendingId(null);
  }, [isOpen, profileKey]);

  const handleConnected = useCallback((id: string) => {
    setConnectedIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isOpen || connectorProfiles.length === 0) return;
    if (!connectorProfiles.every((profile) => connectedIds.has(profile.id))) return;
    if (projectId) {
      void queryClient.invalidateQueries({
        queryKey: ['connector-profiles', projectId],
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
  }, [closeConnectorGate, connectedIds, connectorProfiles, isOpen, projectId, queryClient, retry]);

  const activeProfile =
    pendingId === null
      ? null
      : (connectorProfiles.find((profile) => profile.id === pendingId) ?? null);

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && closeConnectorGate()}>
      <ModalContent className="lg:max-w-lg">
        <ConnectorAuthorizationGateContent
          profiles={connectorProfiles}
          connectedIds={connectedIds}
          pendingId={pendingId}
          canManageProjectAuthorizations={canManageProjectAuthorizations}
          onConnect={(profile) => setPendingId(profile.id)}
          onCancel={closeConnectorGate}
        />
        {activeProfile && projectId ? (
          <ConnectorAuthorizationAction
            projectId={projectId}
            profile={activeProfile}
            active
            onPending={setPendingId}
            onConnected={handleConnected}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}
