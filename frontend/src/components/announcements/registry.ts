import { ComponentType } from 'react';
import { MemoriesAnnouncement } from './components/memories-announcement';

export interface AnnouncementComponentProps {
  onClose: () => void;
  [key: string]: unknown;
}

export const announcementRegistry: Record<string, ComponentType<AnnouncementComponentProps>> = {
  'memories': MemoriesAnnouncement,
};

export function registerAnnouncement(
  name: string, 
  component: ComponentType<AnnouncementComponentProps>
) {
  announcementRegistry[name] = component;
}
