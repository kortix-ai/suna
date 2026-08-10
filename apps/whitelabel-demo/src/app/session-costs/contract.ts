export interface SessionCost {
  session_id: string;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  compute_seconds: number;
  billed_cost: number;
}

export interface SessionCostWorkspace {
  workspaceId: string;
  sessions: SessionCost[];
  error?: string;
}

export interface SessionCostsResponse {
  markup: number;
  totals: {
    raw: number;
    billed: number;
  };
  workspaces: SessionCostWorkspace[];
}
