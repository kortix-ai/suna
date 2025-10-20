import { 
  Sparkles, 
  Code2, 
  PresentationIcon, 
  FileCode2, 
  Headphones,
  Brain,
  Lightbulb,
  Pencil
} from 'lucide-react-native';
import type { Agent } from '../shared/types';
import { MODELS } from '../models/models';

/**
 * Available agents in the system
 * Based on Figma design: node-id=375-10160
 * 
 * Each agent has:
 * - Colored background for visual identity
 * - Icon color contrasting with background
 * - Lucide icon matching the agent's purpose
 */
export const AGENTS: Agent[] = [
  {
    id: 'super-worker',
    name: 'Super Worker',
    icon: Sparkles, // Fallback (not used when isKortixAgent is true)
    iconColor: '#3E3A33', // Not used - theme-aware instead
    backgroundColor: '#FFCD7E', // Not used - transparent for Kortix agent
    description: 'General purpose AI assistant for all tasks',
    isKortixAgent: true, // Special: Uses Kortix Symbol.svg
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'coder',
    name: 'Coder',
    icon: Code2,
    iconColor: '#3E3A33', // Dark brown
    backgroundColor: '#FFCD7E', // Orange/Yellow
    description: 'Expert in writing and debugging code',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'presenter',
    name: 'Presenter',
    icon: PresentationIcon,
    iconColor: '#581F1F', // Dark red
    backgroundColor: '#FF8F8F', // Pink/Red
    description: 'Creates engaging presentations and slides',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'developer',
    name: 'Developer',
    icon: FileCode2,
    iconColor: '#323740', // Dark blue/gray
    backgroundColor: '#6DA4FF', // Blue
    description: 'Full-stack development specialist',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'support',
    name: 'Support',
    icon: Headphones,
    iconColor: '#2C392F', // Dark green
    backgroundColor: '#82DD95', // Green
    description: 'Customer support and assistance',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'analyst',
    name: 'Analyst',
    icon: Brain,
    iconColor: '#323740', // Dark blue/gray
    backgroundColor: '#6DA4FF', // Blue
    description: 'Data analysis and insights expert',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'creative',
    name: 'Creative',
    icon: Lightbulb,
    iconColor: '#581F1F', // Dark red
    backgroundColor: '#FF8F8F', // Pink/Red
    description: 'Creative content and ideation specialist',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  },
  {
    id: 'writer',
    name: 'Writer',
    icon: Pencil,
    iconColor: '#2C392F', // Dark green
    backgroundColor: '#82DD95', // Green
    description: 'Professional writing and content creation',
    models: MODELS,
    selectedModelId: 'claude-sonnet-4'
  }
];

/**
 * Get agent by ID
 */
export function getAgentById(id: string): Agent | undefined {
  return AGENTS.find(agent => agent.id === id);
}

/**
 * Default agent
 */
export const DEFAULT_AGENT = AGENTS[0]; // Super Worker

