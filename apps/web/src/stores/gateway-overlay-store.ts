'use client';

import { create } from 'zustand';

export type GatewaySection =
  | 'overview'
  | 'logs'
  | 'budgets'
  | 'keys'
  | 'playground'
  | 'models'
  | 'providers';

interface GatewayOverlayState {
  open: boolean;
  section: GatewaySection;
  selectedLogId: string | null;
  openGateway: (opts?: { section?: GatewaySection }) => void;
  setSection: (section: GatewaySection) => void;
  selectLog: (logId: string | null) => void;
  close: () => void;
}

export const useGatewayOverlayStore = create<GatewayOverlayState>((set) => ({
  open: false,
  section: 'overview',
  selectedLogId: null,
  openGateway: (opts) =>
    set({ open: true, section: opts?.section ?? 'overview', selectedLogId: null }),
  setSection: (section) => set({ section, selectedLogId: null }),
  selectLog: (logId) => set({ selectedLogId: logId }),
  close: () => set({ open: false, section: 'overview', selectedLogId: null }),
}));
