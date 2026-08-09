import {
  type Icon as IconMynauiType,
  type Icon as IconType,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';
import type { SettingsTab } from './settings-tabs';

export interface RailItem {
  tab: SettingsTab;
  label: string;
  icon?: LucideIcon | IconMynauiType | IconType;
}

export interface RailGroup {
  label: string;
  items: readonly RailItem[];
}
