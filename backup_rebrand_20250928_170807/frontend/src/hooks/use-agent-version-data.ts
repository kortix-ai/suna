import { useMemo, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { useAgentVersion, useVersionStore } from '@/lib/versioning';

interface NormalizedMCP {
  name: string;
  type: string;
  customType: string;
  config: Record<string, any>;
  enabledTools: string[];
}

interface NormalizedVersionData {
  version_id: string;
  agent_id: string;
  version_number: number;
  version_name: string;
  system_prompt: string;
  model?: string;
  configured_mcps: any[];
  custom_mcps: NormalizedMCP[];
  agentpress_tools: Record<string, any>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string;
  change_description?: string;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
}

interface UseAgentVersionDataProps {
  agentId: string;
}

interface UseAgentVersionDataReturn {
  agent: any;
  versionData: NormalizedVersionData | null;
  isViewingOldVersion: boolean;
  isLoading: boolean;
  error: Error | null;
}


function normalizeCustomMcps(mcps: any): NormalizedMCP[] {
  if (!mcps || !Array.isArray(mcps)) {
    return [];
  }
  
  return mcps.map(mcp => {
    if (!mcp || typeof mcp !== 'object') {
      return {
        name: 'Unknown MCP',
        type: 'sse',
        customType: 'sse',
        config: {},
        enabledTools: []
      };
    }
    
    return {
      name: mcp.name || 'Unnamed MCP',
      type: mcp.type || mcp.customType || 'sse',
      customType: mcp.customType || mcp.type || 'sse',
      config: mcp.config || {},
      enabledTools: mcp.enabledTools || mcp.enabled_tools || []
    };
  });
}

function normalizeVersionData(version: any): NormalizedVersionData | null {
  if (!version) return null;
  
  const isApiFormat = 'version_id' in version;
  
  if (isApiFormat) {
    return {
      version_id: version.version_id,
      agent_id: version.agent_id,
      version_number: version.version_number,
      version_name: version.version_name,
      system_prompt: version.system_prompt || '',
      model: version.model,
      configured_mcps: Array.isArray(version.configured_mcps) ? version.configured_mcps : [],
      custom_mcps: normalizeCustomMcps(version.custom_mcps),
      agentpress_tools: version.agentpress_tools && typeof version.agentpress_tools === 'object' 
        ? version.agentpress_tools 
        : {},
      is_active: version.is_active ?? true,
      created_at: version.created_at,
      updated_at: version.updated_at || version.created_at,
      created_by: version.created_by,
      change_description: version.change_description
    };
  } else {
    return {
      version_id: version.versionId?.value || version.versionId,
      agent_id: version.agentId?.value || version.agentId,
      version_number: version.versionNumber?.value || version.versionNumber,
      version_name: version.versionName,
      system_prompt: version.systemPrompt || '',
      model: version.model,  // Add model field
      configured_mcps: Array.isArray(version.configuredMcps) ? version.configuredMcps : [],
      custom_mcps: normalizeCustomMcps(version.customMcps),
      agentpress_tools: version.agentpress_tools || version.toolConfiguration?.tools || {},
      is_active: version.isActive ?? true,
      created_at: version.createdAt instanceof Date ? version.createdAt.toISOString() : version.createdAt,
      updated_at: (version.updatedAt instanceof Date ? version.updatedAt.toISOString() : version.updatedAt) || version.created_at,
      created_by: version.createdBy?.value || version.createdBy,
      change_description: version.changeDescription
    };
  }
}

export function useAgentVersionData({ agentId }: UseAgentVersionDataProps): UseAgentVersionDataReturn {
  const searchParams = useSearchParams();
  const versionParam = searchParams.get('version');
  
  const { data: agent, isLoading: agentLoading, error: agentError } = useAgent(agentId);
  const shouldLoadVersion = versionParam || agent?.current_version_id;
  const versionToLoad = versionParam || agent?.current_version_id || '';
  
  const { data: rawVersionData, isLoading: versionLoading, error: versionError } = useAgentVersion(
    agentId,
    shouldLoadVersion ? versionToLoad : null
  );
  
  const { setCurrentVersion, clearVersionState } = useVersionStore();
  
  const versionData = useMemo(() => {
    const normalized = normalizeVersionData(rawVersionData);
    return normalized;
  }, [rawVersionData]);
  
  const isViewingOldVersion = useMemo(() => {
    return Boolean(versionParam && versionParam !== agent?.current_version_id);
  }, [versionParam, agent?.current_version_id]);

  useEffect(() => {
    if (versionData) {
      setCurrentVersion({
        versionId: { value: versionData.version_id },
        agentId: { value: versionData.agent_id },
        versionNumber: { value: versionData.version_number },
        versionName: versionData.version_name,
        systemPrompt: versionData.system_prompt,
        model: versionData.model,
        configuredMcps: versionData.configured_mcps,
        customMcps: versionData.custom_mcps,
        toolConfiguration: { tools: versionData.agentpress_tools },
        agentpress_tools: versionData.agentpress_tools,
        isActive: versionData.is_active,
        createdAt: new Date(versionData.created_at),
        updatedAt: new Date(versionData.updated_at),
        createdBy: { value: versionData.created_by || '' },
        changeDescription: versionData.change_description,
      });
    } else if (!versionParam) {
      clearVersionState();
    }

    return () => {
      clearVersionState();
    };
  }, [versionData, versionParam, setCurrentVersion, clearVersionState]);
  
  const isLoading = agentLoading || (shouldLoadVersion ? versionLoading : false);
  const error = agentError || versionError;
  
  return {
    agent,
    versionData,
    isViewingOldVersion,
    isLoading,
    error
  };
} 