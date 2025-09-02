import type { LucideIcon } from 'lucide-react';

export interface DocsNavigationItem {
  id: string;
  title: string;
  href?: string;
  icon?: LucideIcon;
  badge?: string;
  children?: DocsNavigationItem[];
  defaultExpanded?: boolean;
}

export interface DocsNavigationSection {
  id: string;
  title: string;
  items: DocsNavigationItem[];
}

export interface DocsNavigation {
  sections: DocsNavigationSection[];
}

export interface DocsSidebarProps {
  navigation: DocsNavigation;
  title?: string;
  subtitle?: string;
  version?: string;
  showThemeToggle?: boolean;
  showSearch?: boolean;
  searchPlaceholder?: string;
  className?: string;
  onNavigate?: (item: DocsNavigationItem) => void;
}

export interface DocsThemeToggleProps {
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'ghost';
  className?: string;
} 