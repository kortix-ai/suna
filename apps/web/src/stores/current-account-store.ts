import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Global "currently active account" state, shared across the dashboard.
 * Persists in localStorage so the user keeps their context between visits.
 *
 * The store is intentionally tiny — it only holds the selected account ID.
 * Account metadata (name, role, etc.) is owned by the /v1/accounts query
 * cache, not duplicated here.
 */
interface CurrentAccountState {
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
  clear: () => void;
}

export const useCurrentAccountStore = create<CurrentAccountState>()(
  persist(
    (set) => ({
      selectedAccountId: null,
      setSelectedAccountId: (id) => set({ selectedAccountId: id }),
      clear: () => set({ selectedAccountId: null }),
    }),
    {
      name: 'kortix.currentAccount',
      version: 1,
    },
  ),
);
