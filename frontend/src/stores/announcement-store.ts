import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  { component: 'memories', props: {} },
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
      name: 'announcement-store-v2',
      partialize: (state) => ({ dismissedAnnouncements: state.dismissedAnnouncements }),
    }
  )
);
