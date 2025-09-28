export interface MCPConfiguration {
  name: string;
  qualifiedName: string;
  mcp_qualified_name?: string; 
  config: Record<string, any>;
  enabledTools: string[];
  selectedProfileId?: string;
  isCustom?: boolean;
  customType?: 'http' | 'sse' | 'composio';
  isComposio?: boolean;
  toolkitSlug?: string;
}
  
export interface MCPConfigurationProps {
  configuredMCPs: MCPConfiguration[];
  onConfigurationChange: (mcps: MCPConfiguration[]) => void;
  agentId?: string;
  versionData?: {
    configured_mcps?: any[];
    custom_mcps?: any[];
    system_prompt?: string;
    agentpress_tools?: any;
  };
  saveMode?: 'direct' | 'callback';
  versionId?: string;
  isLoading?: boolean;
}
