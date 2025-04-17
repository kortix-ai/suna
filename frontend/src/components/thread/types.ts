import type { ElementType } from 'react';
import type { Project } from '@/lib/api';

// Define a type for the params to make React.use() work properly
export type ThreadParams = { 
  threadId: string;
};

export interface ApiMessage {
  role: string;
  content: string;
  type?: string;
  name?: string;
  arguments?: string;
  tool_call?: {
    id: string;
    function: {
      name: string;
      arguments: string;
    };
    type: string;
    index: number;
  };
}

// Define structure for grouped tool call/result sequences
export type ToolSequence = {
  type: 'tool_sequence';
  items: ApiMessage[];
};

// Type for items that will be rendered
export type RenderItem = ApiMessage | ToolSequence;

// Type guard to check if an item is a ToolSequence
export function isToolSequence(item: RenderItem): item is ToolSequence {
  return (item as ToolSequence).type === 'tool_sequence';
}

// Re-export existing types
export type { Project }; 