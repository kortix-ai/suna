import { create } from 'zustand';

export interface ConnectorGateProfile {
  id: string;
  slug: string;
  name: string;
  authorization_strategy: 'project' | 'user';
}

/**
 * Drives the global connector authorization gate. A failed session create opens
 * this gate with every missing connector profile. The gate retries the same
 * session create after all required authorizations are connected.
 */
interface ConnectorGateState {
  isOpen: boolean;
  projectId: string | null;
  connectorProfiles: ConnectorGateProfile[];
  /** Re-run the gated session-create after the connector is connected. */
  retry: (() => void) | null;
  openConnectorGate: (opts: {
    projectId: string;
    connectorProfiles: ConnectorGateProfile[];
    retry: () => void;
  }) => void;
  closeConnectorGate: () => void;
}

export const useConnectorGateStore = create<ConnectorGateState>((set) => ({
  isOpen: false,
  projectId: null,
  connectorProfiles: [],
  retry: null,
  openConnectorGate: ({ projectId, connectorProfiles, retry }) =>
    set({ isOpen: true, projectId, connectorProfiles, retry }),
  closeConnectorGate: () =>
    set({ isOpen: false, projectId: null, connectorProfiles: [], retry: null }),
}));
