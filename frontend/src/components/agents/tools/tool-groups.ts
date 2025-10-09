/**
 * Tool Groups Types and Utilities
 * 
 * FULLY API-DRIVEN - NO STATIC DATA
 * All tool metadata is fetched from the backend auto-discovery system.
 * 
 * Use the useToolsMetadata() hook to fetch tool data:
 * import { useToolsMetadata } from '@/hooks/react-query/tools/use-tools-metadata';
 */

export interface ToolMethod {
  name: string;
  displayName?: string;
  display_name?: string;
  description: string;
  enabled: boolean;
  isCore?: boolean;
  is_core?: boolean;
  visible?: boolean; // Whether method is visible in UI
}

export interface ToolGroup {
  name: string;
  displayName?: string;
  display_name?: string;
  description: string;
  icon?: string;
  color?: string;
  toolClass?: string;
  tool_class?: string;
  methods: ToolMethod[];
  enabled: boolean;
  isCore?: boolean;
  is_core?: boolean;
  weight?: number; // Sort order (lower = higher priority)
  visible?: boolean; // Whether tool is visible in UI
}

/**
 * Convert API response format to frontend format
 */
export function normalizeToolGroup(apiToolGroup: any): ToolGroup {
  return {
    name: apiToolGroup.name,
    displayName: apiToolGroup.display_name || apiToolGroup.displayName,
    display_name: apiToolGroup.display_name,
    description: apiToolGroup.description,
    icon: apiToolGroup.icon,
    color: apiToolGroup.color,
    toolClass: apiToolGroup.tool_class || apiToolGroup.toolClass,
    tool_class: apiToolGroup.tool_class,
    methods: apiToolGroup.methods?.map((m: any) => ({
      name: m.name,
      displayName: m.display_name || m.displayName,
      display_name: m.display_name,
      description: m.description,
      enabled: m.enabled ?? true,
      isCore: m.is_core || m.isCore,
      is_core: m.is_core,
      visible: m.visible, // Use API value directly - backend controls visibility
    })) || [],
    enabled: apiToolGroup.enabled ?? true,
    isCore: apiToolGroup.is_core || apiToolGroup.isCore,
    is_core: apiToolGroup.is_core,
    weight: apiToolGroup.weight ?? 100,
    visible: apiToolGroup.visible, // Use API value directly - backend controls visibility
  };
}

/**
 * Sort tools by weight (lower = higher priority)
 */
export function sortToolsByWeight(tools: Record<string, ToolGroup>): ToolGroup[] {
  return Object.values(tools).sort((a, b) => (a.weight ?? 100) - (b.weight ?? 100));
}

export function getToolGroup(toolName: string, toolsData?: Record<string, any>): ToolGroup | undefined {
  if (!toolsData || !toolsData[toolName]) return undefined;
  return normalizeToolGroup(toolsData[toolName]);
}

export function getAllToolGroups(toolsData?: Record<string, any>): Record<string, ToolGroup> {
  if (!toolsData) return {};
  
  const normalized: Record<string, ToolGroup> = {};
  for (const [name, data] of Object.entries(toolsData)) {
    normalized[name] = normalizeToolGroup(data);
  }
  return normalized;
}

export function hasGranularControl(toolName: string, toolsData?: Record<string, any>): boolean {
  const group = getToolGroup(toolName, toolsData);
  if (!group) return false;
  
  // Only count visible methods for granular control (visible=true or visible=undefined counts as visible)
  const visibleMethods = group.methods.filter(m => m.visible !== false);
  console.log(`[hasGranularControl] ${toolName}: ${group.methods.length} total methods, ${visibleMethods.length} visible`, group.methods.map(m => ({ name: m.name, visible: m.visible })));
  return visibleMethods.length > 1;
}

export function getEnabledMethodsForTool(
  toolName: string, 
  config: any, 
  toolsData?: Record<string, any>
): string[] {
  const toolGroup = getToolGroup(toolName, toolsData);
  if (!toolGroup) {
    return [];
  }

  const toolConfig = config[toolName];
  if (typeof toolConfig === 'boolean' && !toolConfig) {
    return [];
  }

  if (toolConfig === true || toolConfig === undefined) {
    return toolGroup.methods.filter(method => method.enabled).map(method => method.name);
  }

  if (typeof toolConfig === 'object' && toolConfig !== null) {
    if (!toolConfig.enabled) {
      return [];
    }

    const methodsConfig = toolConfig.methods || {};
    const enabledMethods: string[] = [];

    for (const method of toolGroup.methods) {
      let methodEnabled = method.enabled;
      if (method.name in methodsConfig) {
        const methodConfig = methodsConfig[method.name];
        if (typeof methodConfig === 'boolean') {
          methodEnabled = methodConfig;
        } else if (typeof methodConfig === 'object' && methodConfig !== null) {
          methodEnabled = methodConfig.enabled ?? method.enabled;
        }
      }

      if (methodEnabled) {
        enabledMethods.push(method.name);
      }
    }

    return enabledMethods;
  }

  return toolGroup.methods.filter(method => method.enabled).map(method => method.name);
}

export function validateToolConfig(
  config: Record<string, any>, 
  toolsData?: Record<string, any>
): Record<string, any> {
  const normalizedConfig: Record<string, any> = {};

  for (const [toolName, toolConfig] of Object.entries(config)) {
    const toolGroup = getToolGroup(toolName, toolsData);
    if (!toolGroup) {
      normalizedConfig[toolName] = toolConfig;
      continue;
    }

    if (toolGroup.isCore) {
      normalizedConfig[toolName] = true;
      continue;
    }

    if (typeof toolConfig === 'boolean') {
      normalizedConfig[toolName] = toolConfig;
    } else if (typeof toolConfig === 'object' && toolConfig !== null) {
      const validatedConfig: any = {
        enabled: toolConfig.enabled ?? true,
        methods: {},
      };

      const methodsConfig = toolConfig.methods || {};
      for (const method of toolGroup.methods) {
        if (method.name in methodsConfig) {
          const methodConfig = methodsConfig[method.name];
          if (typeof methodConfig === 'boolean') {
            validatedConfig.methods[method.name] = methodConfig;
          } else if (typeof methodConfig === 'object' && methodConfig !== null) {
            validatedConfig.methods[method.name] = {
              enabled: methodConfig.enabled ?? method.enabled,
            };
          } else {
            validatedConfig.methods[method.name] = method.enabled;
          }
        } else {
          validatedConfig.methods[method.name] = method.enabled;
        }
      }

      normalizedConfig[toolName] = validatedConfig;
    } else {
      normalizedConfig[toolName] = true;
    }
  }

  return normalizedConfig;
}

export function convertLegacyToolConfig(
  legacyTools: Record<string, boolean | { enabled: boolean; description: string }>,
  toolsData?: Record<string, any>
): Record<string, any> {
  const convertedConfig: Record<string, any> = {};

  for (const [toolName, toolConfig] of Object.entries(legacyTools)) {
    const toolGroup = getToolGroup(toolName, toolsData);
    
    if (!toolGroup) {
      convertedConfig[toolName] = toolConfig;
      continue;
    }

    if (typeof toolConfig === 'boolean') {
      convertedConfig[toolName] = toolConfig;
    } else if (typeof toolConfig === 'object' && 'enabled' in toolConfig) {
      convertedConfig[toolName] = toolConfig.enabled;
    } else {
      convertedConfig[toolName] = true;
    }
  }

  return convertedConfig;
}

// Legacy export for backward compatibility - components should pass toolsData
export const TOOL_GROUPS: Record<string, ToolGroup> = {};
