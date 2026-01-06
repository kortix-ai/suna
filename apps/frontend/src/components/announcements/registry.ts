import { ComponentType } from 'react';

export interface AnnouncementComponentProps {
  onClose: () => void;
  [key: string]: unknown;
}

export const announcementRegistry: Record<string, ComponentType<AnnouncementComponentProps>> = {};

export function registerAnnouncement(
  name: string, 
  component: ComponentType<AnnouncementComponentProps>
) {
  announcementRegistry[name] = component;
}
