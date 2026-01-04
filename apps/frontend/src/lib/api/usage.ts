// Usage log types

export interface UsageLogEntry {
  message_id: string;
  thread_id: string;
  created_at: string;
  content: {
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
    };
    model: string;
  };
  total_tokens: number;
  estimated_cost: number | string;
  project_id: string;
  credit_used?: number;
  payment_method?: 'credits' | 'subscription';
  was_over_limit?: boolean;
}

export interface UsageLogsResponse {
  logs: UsageLogEntry[];
  has_more: boolean;
  total_count?: number;
}

