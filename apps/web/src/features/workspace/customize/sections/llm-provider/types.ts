export interface ProjectProviderModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asPanel?: boolean;
  /**
   * Read-only members see the page but not the connect/change/disconnect
   * controls (which mutate and would 403). Fails safe: a missing value is
   * treated as read-only.
   */
  canWrite?: boolean;
}

export interface CustomFormState {
  protocol: 'openai' | 'anthropic';
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
}

export type ChatGptPhase = 'idle' | 'waiting' | 'done';

export type ChatGptChallenge = { url: string; code: string | null };
