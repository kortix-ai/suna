import { 
  Brain,
  MessageSquare,
  Zap
} from 'lucide-react-native';
import type { Model } from '../shared/types';

/**
 * Available AI models in the system
 * Based on Figma design: node-id=375-9640
 * 
 * Each model has:
 * - Colored background for visual identity
 * - Icon color contrasting with background
 * - Lucide icon matching the model's purpose
 */
export const MODELS: Model[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    icon: Brain,
    iconColor: '#F8F8F8',
    backgroundColor: '#161618',
    description: 'Fast and efficient AI with 67% cost reduction',
    costInfo: 'Input: $1.20 • Output: $6.00',
    isSelected: true // Default selected model
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    icon: Brain,
    iconColor: '#F8F8F8',
    backgroundColor: '#161618',
    description: 'Advanced reasoning and analysis',
    costInfo: 'Input: $3.60 • Output: $18.00'
  },
  // Commented out non-Anthropic models as requested
  // {
  //   id: 'chatgpt-5',
  //   name: 'ChatGPT 5',
  //   icon: MessageSquare,
  //   iconColor: '#F8F8F8',
  //   backgroundColor: '#161618',
  //   description: 'Conversational AI with broad knowledge'
  // },
  // {
  //   id: 'grok-4',
  //   name: 'Grok 4',
  //   icon: Zap,
  //   iconColor: '#F8F8F8',
  //   backgroundColor: '#161618',
  //   description: 'Fast and efficient AI processing'
  // }
];

/**
 * Get model by ID
 */
export function getModelById(id: string): Model | undefined {
  return MODELS.find(model => model.id === id);
}

/**
 * Default model
 */
export const DEFAULT_MODEL = MODELS[0]; // Claude Haiku 4.5
