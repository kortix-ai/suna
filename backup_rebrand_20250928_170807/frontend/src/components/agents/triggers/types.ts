export interface TriggerProvider {
  provider_id: string;
  name: string;
  description?: string;
  trigger_type: string;
  webhook_enabled: boolean;
  config_schema: Record<string, any>;
}

export interface TriggerConfiguration {
  trigger_id: string;
  agent_id: string;
  trigger_type: string;
  provider_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  config?: Record<string, any>;
}

export interface TelegramTriggerConfig {
  bot_token: string;
  secret_token?: string;
  allowed_users?: number[];
  allowed_chats?: number[];
  trigger_commands?: string[];
  trigger_keywords?: string[];
  respond_to_all_messages?: boolean;
  response_mode?: 'reply' | 'new_message';
}

export interface SlackTriggerConfig {
  signing_secret: string;
  bot_token?: string;
  allowed_channels?: string[];
  trigger_keywords?: string[];
  respond_to_mentions?: boolean;
  respond_to_direct_messages?: boolean;
}

export interface WebhookTriggerConfig {
  webhook_url?: string;
  secret?: string;
  headers_validation?: Record<string, string>;
  expected_content_type?: string;
}

export interface GitHubTriggerConfig {
  secret: string;
  events: string[];
  repository?: string;
}

export interface DiscordTriggerConfig {
  webhook_url: string;
  bot_token?: string;
  allowed_channels?: string[];
  trigger_keywords?: string[];
}

export interface ScheduleTriggerConfig {
  cron_expression: string;
  execution_type: 'agent' | 'workflow';
  agent_prompt?: string;
  workflow_id?: string;
  workflow_input?: Record<string, any>;
  timezone?: string;
}

export interface EventTriggerConfig {
  profile_id?: string;
  agent_prompt: string;
  trigger_slug: string;
  execution_type: 'agent' | 'workflow';
  composio_trigger_id?: string;
  workflow_id?: string;
  workflow_input?: Record<string, any>;
} 