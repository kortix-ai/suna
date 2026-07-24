import { create } from 'zustand';

/**
 * Drives the global "Connect X to start this session" gate. A session-create that
 * fails with CONNECTOR_CONNECTION_REQUIRED (the acting user hasn't connected a
 * required connector) opens this; once they connect their own account, `retry`
 * re-runs the exact create that was gated.
 */
interface ConnectorGateState {
  isOpen: boolean;
  projectId: string | null;
  /** The connector alias the user must connect (from the error's `connector`). */
  connector: string | null;
  /** Re-run the gated session-create after the connector is connected. */
  retry: (() => void) | null;
  openConnectorGate: (opts: { projectId: string; connector: string; retry: () => void }) => void;
  closeConnectorGate: () => void;
}

export const useConnectorGateStore = create<ConnectorGateState>((set) => ({
  isOpen: false,
  projectId: null,
  connector: null,
  retry: null,
  openConnectorGate: ({ projectId, connector, retry }) =>
    set({ isOpen: true, projectId, connector, retry }),
  closeConnectorGate: () => set({ isOpen: false, projectId: null, connector: null, retry: null }),
}));
