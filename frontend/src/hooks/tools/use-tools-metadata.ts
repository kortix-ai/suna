import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface ToolMethod {
  name: string;
  display_name: string;
  description: string;
  enabled: boolean;
  is_core?: boolean;
  visible?: boolean; // Whether method is visible in UI
}

export interface ToolMetadata {
  name: string;
  display_name: string;
  description: string;
  tool_class: string;
  icon?: string;
  color?: string;
  enabled: boolean;
  is_core?: boolean;
  weight?: number; // Sort order (lower = higher priority)
  visible?: boolean; // Whether tool is visible in UI
  methods: ToolMethod[];
}

export interface ToolsMetadataResponse {
  success: boolean;
  tools: Record<string, ToolMetadata>;
}

/**
 * Hook to fetch all tools metadata from the backend API.
 * This replaces the static tool-groups-comprehensive.ts file.
 */
export function useToolsMetadata() {
  return useQuery<ToolsMetadataResponse>({
    queryKey: ['tools', 'metadata'],
    queryFn: async () => {
      const response = await backendApi.get<{ success: boolean; tools: ToolMetadata[] }>('/tools');
      if (!response.success || !response.data) {
        throw new Error('Failed to fetch tools metadata');
      }
      
      // Backend returns array, convert to object keyed by tool name
      const toolsArray = response.data.tools;
      const toolsObject: Record<string, ToolMetadata> = {};
      
      for (const tool of toolsArray) {
        toolsObject[tool.name] = tool;
      }
      
      return {
        success: response.data.success,
        tools: toolsObject
      };
    },
    staleTime: 1000 * 60 * 60, // Cache for 1 hour since tools don't change frequently
    gcTime: 1000 * 60 * 60 * 24, // Keep in cache for 24 hours
  });
}

/**
 * Hook to fetch metadata for a specific tool.
 */
export function useToolMetadata(toolName: string) {
  return useQuery<{ success: boolean; tool: ToolMetadata }>({
    queryKey: ['tools', 'metadata', toolName],
    queryFn: async () => {
      const response = await backendApi.get<{ success: boolean; tool: ToolMetadata }>(`/tools/${toolName}`);
      if (!response.success || !response.data) {
        throw new Error(`Failed to fetch tool metadata for ${toolName}`);
      }
      return response.data;
    },
    enabled: !!toolName,
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
  });
}

