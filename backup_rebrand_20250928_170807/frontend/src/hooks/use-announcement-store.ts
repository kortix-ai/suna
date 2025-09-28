import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AnnouncementAction {
  id: string;
  label: string;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  onClick: () => void;
}

export interface BaseAnnouncement {
  id: string;
  type: AnnouncementType;
  title: string;
  description?: string;
  customContent?: React.ReactNode;
  htmlContent?: string;
  timestamp: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  persistent?: boolean;
  autoCloseDelay?: number;
  actions?: AnnouncementAction[];
  metadata?: Record<string, any>;
  version?: string;
  targetAudience?: string[];
}

export type AnnouncementType = 
  | 'feature-launch' 
  | 'ai-agents-mcp'
  | 'product-update' 
  | 'maintenance' 
  | 'celebration'
  | 'onboarding'
  | 'beta-access'
  | 'premium-upgrade'
  | 'survey'
  | 'changelog';

interface AnnouncementStore {
  announcements: BaseAnnouncement[];
  dismissedAnnouncements: Set<string>;
  currentAnnouncement: BaseAnnouncement | null;
  isOpen: boolean;
  
  addAnnouncement: (announcement: Omit<BaseAnnouncement, 'id' | 'timestamp'>) => string;
  showAnnouncement: (id: string) => void;
  dismissAnnouncement: (id: string) => void;
  closeDialog: () => void;
  openDialog: () => void;
  getActiveAnnouncements: () => BaseAnnouncement[];
  clearAllAnnouncements: () => void;
  
  hasUnseenAnnouncements: () => boolean;
  getAnnouncementsByType: (type: AnnouncementType) => BaseAnnouncement[];
  markAllAsSeen: () => void;
}

export const useAnnouncementStore = create<AnnouncementStore>()(
  persist(
    (set, get) => ({
      announcements: [],
      dismissedAnnouncements: new Set<string>(),
      currentAnnouncement: null,
      isOpen: false,
      
      addAnnouncement: (announcement) => {
        const newAnnouncement: BaseAnnouncement = {
          ...announcement,
          id: `announcement_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: Date.now()
        };
        
        set((state) => ({
          announcements: [...state.announcements, newAnnouncement]
        }));
        
        if (announcement.priority === 'high' || announcement.priority === 'urgent') {
          setTimeout(() => {
            get().showAnnouncement(newAnnouncement.id);
          }, 500);
        }
        
        return newAnnouncement.id;
      },
      
      showAnnouncement: (id) => {
        const announcement = get().announcements.find(n => n.id === id);
        if (announcement && !get().dismissedAnnouncements.has(id)) {
          set({ 
            currentAnnouncement: announcement,
            isOpen: true 
          });
        }
      },
      
      dismissAnnouncement: (id) => {
        set((state) => ({
          dismissedAnnouncements: new Set([...state.dismissedAnnouncements, id])
        }));
        const current = get().currentAnnouncement;
        if (current?.id === id) {
          get().closeDialog();
        }
      },
      
      closeDialog: () => set({ 
        isOpen: false,
        currentAnnouncement: null 
      }),
      
      openDialog: () => set({ isOpen: true }),
      
      getActiveAnnouncements: () => {
        const { announcements, dismissedAnnouncements } = get();
        return announcements
          .filter(a => !dismissedAnnouncements.has(a.id))
          .sort((a, b) => {
            const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
            return priorityOrder[b.priority] - priorityOrder[a.priority];
          });
      },
      
      clearAllAnnouncements: () => set({ 
        announcements: [],
        currentAnnouncement: null,
        isOpen: false
      }),
      
      hasUnseenAnnouncements: () => {
        return get().getActiveAnnouncements().length > 0;
      },
      
      getAnnouncementsByType: (type) => {
        return get().announcements.filter(a => a.type === type);
      },
      
      markAllAsSeen: () => {
        const allIds = get().announcements.map(a => a.id);
        set({
          dismissedAnnouncements: new Set(allIds)
        });
      }
    }),
    {
      name: 'announcement-storage',
      partialize: (state) => ({ 
        dismissedAnnouncements: Array.from(state.dismissedAnnouncements),
        announcements: state.announcements.filter(a => a.persistent)
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.dismissedAnnouncements = new Set(state.dismissedAnnouncements || []);
        }
      }
    }
  )
);
