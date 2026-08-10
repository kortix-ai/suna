import { create } from 'zustand';

export interface ConnectorGateConnection {
  id: string;
  slug: string;
  name: string;
  authorization_strategy: 'workspace' | 'user';
}

/**
 * Drives the global connection gate. A failed session create opens this gate
 * with every missing connection. The gate retries the same
 * session create after all required connections are created.
 */
interface ConnectorGateState {
  isOpen: boolean;
  workspaceId: string | null;
  connectorConnections: ConnectorGateConnection[];
  /** Re-run the gated session-create after the connector is connected. */
  retry: (() => void) | null;
  openConnectorGate: (opts: {
    workspaceId: string;
    connectorConnections: ConnectorGateConnection[];
    retry: () => void;
  }) => void;
  closeConnectorGate: () => void;
}

export const useConnectorGateStore = create<ConnectorGateState>((set) => ({
  isOpen: false,
  workspaceId: null,
  connectorConnections: [],
  retry: null,
  openConnectorGate: ({ workspaceId, connectorConnections, retry }) =>
    set({ isOpen: true, workspaceId, connectorConnections, retry }),
  closeConnectorGate: () =>
    set({ isOpen: false, workspaceId: null, connectorConnections: [], retry: null }),
}));
