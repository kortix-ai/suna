import { CustomizeSection } from '@/lib/customize-sections';
import { type LucideIcon } from 'lucide-react';

export interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon;
}

export interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}
