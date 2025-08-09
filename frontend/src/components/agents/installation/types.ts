export interface MarketplaceTemplate {
  id: string;
  creator_id: string;
  name: string;
  description: string;
  tags: string[];
  download_count: number;
  creator_name: string;
  created_at: string;
  marketplace_published_at?: string;
  avatar?: string;
  avatar_color?: string;
  template_id: string;
  is_kortix_team?: boolean;
  agentpress_tools?: Record<string, any>;
  mcp_requirements?: Array<{
    qualified_name: string;
    display_name: string;
    enabled_tools?: string[];
    required_config: string[];
    custom_type?: 'sse' | 'http' | 'composio';
  }>;
  metadata?: {
    source_agent_id?: string;
    source_version_id?: string;
    source_version_name?: string;
  };
}

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  type: 'credential_profile' | 'custom_server' | 'composio_profile';
  service_name: string;
  qualified_name: string;
  required_fields?: Array<{
    key: string;
    label: string;
    type: 'text' | 'url' | 'password';
    placeholder: string;
    description?: string;
  }>;
  custom_type?: 'sse' | 'http' | 'composio'; 
  app_slug?: string;
  app_name?: string;
} 