import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

export interface AnnouncementData {
  component: string;
  props?: Record<string, unknown>;
}

interface AnnouncementStore {
  isOpen: boolean;
  currentAnnouncement: AnnouncementData | null;
  dismissedAnnouncements: string[];
  openAnnouncement: (announcement: AnnouncementData) => void;
  closeAnnouncement: () => void;
  hasSeenAnnouncement: (component: string) => boolean;
  showPendingAnnouncement: () => void;
}

const PENDING_ANNOUNCEMENTS: AnnouncementData[] = [
  // Add announcements here when the corresponding component is registered in registry.ts
  // Example: { component: 'memories', props: {} },
];

export const useAnnouncementStore = create<AnnouncementStore>()(
  persist(
    (set, get) => ({
      isOpen: false,
      currentAnnouncement: null,
      dismissedAnnouncements: [],

      openAnnouncement: (announcement) => {
        const { dismissedAnnouncements } = get();
        if (dismissedAnnouncements.includes(announcement.component)) {
          return;
        }
        set({ isOpen: true, currentAnnouncement: announcement });
      },

      closeAnnouncement: () => {
        const { currentAnnouncement, dismissedAnnouncements } = get();
        if (currentAnnouncement && !dismissedAnnouncements.includes(currentAnnouncement.component)) {
          set({
            isOpen: false,
            currentAnnouncement: null,
            dismissedAnnouncements: [...dismissedAnnouncements, currentAnnouncement.component],
          });
        } else {
          set({ isOpen: false, currentAnnouncement: null });
        }
      },

      hasSeenAnnouncement: (component: string) => {
        return get().dismissedAnnouncements.includes(component);
      },

      showPendingAnnouncement: () => {
        const { dismissedAnnouncements, isOpen } = get();
        if (isOpen) return;

        const pending = PENDING_ANNOUNCEMENTS.find(
          (a) => !dismissedAnnouncements.includes(a.component)
        );

        if (pending) {
          set({ isOpen: true, currentAnnouncement: pending });
        }
      },
    }),
    {
      // `kortix.` prefixed (not the historical `announcement-store-v2`) so the
      // sign-out sweep's prefix match covers it structurally — see
      // `APP_STORAGE_PREFIXES` in `lib/utils/clear-local-storage.ts`. Which
      // announcements a browser has dismissed is per-account state; the old
      // unprefixed name meant it silently outlived a sign-out.
      name: 'kortix.announcements-v2',
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ dismissedAnnouncements: state.dismissedAnnouncements }),
    }
  )
);

// Registers this store for `resetClientState()`'s sign-out sweep without
// `reset-client-state.ts` importing this file — see `persisted-store-registry.ts`.
registerPersistedStore('kortix.announcements-v2', () => resetPersistedStore(useAnnouncementStore));
