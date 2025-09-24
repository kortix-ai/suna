import { createSupabaseClient } from '@/constants/SupabaseConfig';
import { SERVER_URL } from '@/constants/Server';

export type Model = {
  id: string;
  display_name: string;
  short_name?: string;
  requires_subscription?: boolean;
  is_available?: boolean;
  input_cost_per_million_tokens?: number | null;
  output_cost_per_million_tokens?: number | null;
  max_tokens?: number | null;
  context_window?: number | null;
  capabilities?: string[];
  recommended?: boolean;
  priority?: number;
};

export type AvailableModelsResponse = {
  models: Model[];
  subscription_tier: string;
  total_models: number;
};

export type Agent = {
  agent_id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  configured_mcps?: Array<{
    name: string;
    config: Record<string, any>;
  }>;
  custom_mcps?: Array<{
    name: string;
    type?: string;
    customType?: string;
    config?: Record<string, any>;
    enabledTools?: string[];
  }>;
  agentpress_tools?: Record<string, any>;
  is_default?: boolean;
  metadata?: {
    is_suna_default?: boolean;
    centrally_managed?: boolean;
  };
};

export type AgentsResponse = {
  agents: Agent[];
  pagination: {
    current_page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
};

export type KnowledgeBaseEntry = {
  entry_id: string;
  name: string;
  description?: string;
  usage_context?: 'always' | 'on_request' | 'contextual';
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type KnowledgeBaseListResponse = {
  entries: KnowledgeBaseEntry[];
  total_count: number;
  total_tokens: number;
};

export type TriggerConfiguration = {
  trigger_id: string;
  agent_id: string;
  provider_id: string;
  name: string;
  description?: string;
  config: Record<string, any>;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

const API_URL = SERVER_URL;

const getAuthHeaders = async () => {
  const supabase = createSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('No access token available. Please sign in again.');
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
};

export const fetchAvailableModels = async (): Promise<AvailableModelsResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/billing/available-models`, {
    headers,
  });
  return handleResponse<AvailableModelsResponse>(response);
};

export const fetchAgents = async (limit = 50): Promise<AgentsResponse> => {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams({ limit: limit.toString() });
  const response = await fetch(`${API_URL}/agents?${params.toString()}`, {
    headers,
  });
  return handleResponse<AgentsResponse>(response);
};

export const fetchAgentDetails = async (agentId: string): Promise<Agent> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/agents/${agentId}`, {
    headers,
  });
  return handleResponse<Agent>(response);
};

export const fetchAgentKnowledgeBase = async (
  agentId: string,
): Promise<KnowledgeBaseListResponse> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/knowledge-base/agents/${agentId}`, {
    headers,
  });
  return handleResponse<KnowledgeBaseListResponse>(response);
};

export const updateKnowledgeBaseEntry = async (
  entryId: string,
  updates: Partial<Pick<KnowledgeBaseEntry, 'name' | 'description' | 'is_active' | 'usage_context'>>,
): Promise<KnowledgeBaseEntry> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/knowledge-base/${entryId}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  return handleResponse<KnowledgeBaseEntry>(response);
};

export const fetchAgentTriggers = async (
  agentId: string,
): Promise<TriggerConfiguration[]> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/triggers/agents/${agentId}/triggers`, {
    headers,
  });
  return handleResponse<TriggerConfiguration[]>(response);
};

export const updateTriggerState = async (
  triggerId: string,
  updates: Partial<Pick<TriggerConfiguration, 'name' | 'description' | 'config' | 'is_active'>>,
): Promise<TriggerConfiguration> => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/triggers/${triggerId}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  return handleResponse<TriggerConfiguration>(response);
};
