import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface AgentTool {
  name: string;
  description: string;
  type: 'agentpress' | 'mcp';
  server?: string;
  enabled: boolean;
  icon?: string;
  color?: string;
}

interface AgentToolsResponse {
  agentpress_tools: AgentTool[];
  mcp_tools: AgentTool[];
}

const fetchAgentTools = async (agentId: string): Promise<AgentToolsResponse> => {

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to get agent tools');
  }

  const response = await fetch(`${API_URL}/agents/${agentId}/tools`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }

  const toolsResponse = await response.json() as AgentToolsResponse;
  return toolsResponse;
};

export const useAgentTools = (agentId: string) => {
  return useQuery({
    queryKey: ['agent-tools', agentId],
    queryFn: () => fetchAgentTools(agentId),
    staleTime: 5 * 60 * 1000,
    enabled: !!agentId,
  });
}; 