'use client';

import { create } from 'zustand';

export type GatewaySection =
  | 'overview'
  | 'cost'
  | 'usage'
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
  days: number;
  openGateway: (opts?: { section?: GatewaySection }) => void;
  setSection: (section: GatewaySection) => void;
  selectLog: (logId: string | null) => void;
  setDays: (days: number) => void;
  close: () => void;
}

export const useGatewayOverlayStore = create<GatewayOverlayState>((set) => ({
  open: false,
  section: 'overview',
  selectedLogId: null,
  days: 30,
  openGateway: (opts) =>
    set({ open: true, section: opts?.section ?? 'overview', selectedLogId: null }),
  setSection: (section) => set({ section, selectedLogId: null }),
  selectLog: (logId) => set({ selectedLogId: logId }),
  setDays: (days) => set({ days }),
  close: () => set({ open: false, section: 'overview', selectedLogId: null }),
}));
