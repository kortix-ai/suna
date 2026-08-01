import { CustomizeSection } from '@/lib/customize-sections';
import {
  type Icon as IconMynauiType,
  type Icon as IconType,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';

export interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon | IconMynauiType | IconType;
}

export interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}
