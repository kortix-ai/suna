'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';

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
import { useConnectorGateStore } from '@/stores/connector-gate-store';

/**
 * Globally-mounted gate for CONNECTOR_CONNECTION_REQUIRED. When a session refuses
 * to start because the acting user hasn't connected a required connector (their
 * OWN account), this prompts them to connect it inline (the private member
 * connect), then re-runs the exact create that was gated.
 */
export function ConnectorConnectionGateDialog() {
  const { isOpen, projectId, connector, retry, closeConnectorGate } = useConnectorGateStore();
  const queryClient = useQueryClient();
  const connect = usePipedreamConnectMember(projectId ?? '', connector ?? '', () => {
    if (projectId) queryClient.invalidateQueries({ queryKey: ['connector-profiles', projectId] });
    // Capture the retry before we clear the store, then re-run the gated create.
    const run = retry;
    closeConnectorGate();
    run?.();
  });

  const label = connector ?? 'this connector';

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && closeConnectorGate()}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            <Lock className="size-4" />
            Connect {label} to start
          </ModalTitle>
          <ModalDescription>
            This session runs on your own {label} connection, and you haven't connected it yet.
            Connect it once to start — it stays private to you, separate from the team's shared
            connection.
          </ModalDescription>
        </ModalHeader>
        <ModalFooter>
          <Button variant="ghost" onClick={closeConnectorGate} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button
            className="gap-2"
            onClick={() => projectId && connector && connect.mutate()}
            disabled={connect.isPending || !projectId || !connector}
          >
            {connect.isPending ? <Loading className="size-4" /> : <Lock className="size-4" />}
            Connect {label}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
