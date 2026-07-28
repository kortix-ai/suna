import type { CustomizeSection } from '@/lib/customize-sections';
import type { Icon as IconMynauiType } from '@mynaui/icons-react';
import type { LucideIcon } from 'lucide-react';
import type { IconType } from 'react-icons/lib';

export interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon | IconMynauiType | IconType;
}

export interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}
