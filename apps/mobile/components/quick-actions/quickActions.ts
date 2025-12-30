import { 
  Image, 
  Presentation, 
  Table2, 
  FileText, 
  Users, 
  Search,
  Sparkles
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

/**
 * Quick Action Type Definition
 */
export interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Quick Actions Configuration
 * 
 * Predefined quick actions that appear above the chat input.
 * Each action represents a capability or tool the user can access.
 */
export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'general',
    label: 'General',
    icon: Sparkles,
  },
  {
    id: 'slides',
    label: 'Slides',
    icon: Presentation,
  },
  {
    id: 'research',
    label: 'Research',
    icon: Search,
  },
  {
    id: 'docs',
    label: 'Docs',
    icon: FileText,
  },
  {
    id: 'image',
    label: 'Image',
    icon: Image,
  },
  {
    id: 'data',
    label: 'Data',
    icon: Table2,
  },
  {
    id: 'people',
    label: 'People',
    icon: Users,
  },
];

