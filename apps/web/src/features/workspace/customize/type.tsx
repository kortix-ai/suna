import { CustomizeSection } from '@/lib/customize-sections';
import { Icon as IconMynauiType } from '@mynaui/icons-react';
import { LucideIcon } from 'lucide-react';
import { IconType } from 'react-icons/lib';

export interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon | IconMynauiType | IconType;
}

export interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}
