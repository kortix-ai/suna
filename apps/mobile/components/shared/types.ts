import type { LucideIcon } from 'lucide-react-native';

export type AgentIconType = 'lucide' | 'svg' | 'image';

export interface Model {
  id: string;
  name: string;
  icon: LucideIcon;
  iconColor: string;
  backgroundColor: string;
  description?: string;
  isSelected?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  icon: LucideIcon;
  iconColor: string;
  backgroundColor: string;
  description?: string;
  isKortixAgent?: boolean; // Special flag for Super Worker (uses Kortix symbol)
  models?: Model[]; // Available models for this agent
  selectedModelId?: string; // Currently selected model
}

export interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onPress?: () => void;
  isSelected?: boolean;
}
