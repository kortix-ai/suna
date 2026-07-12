export type ActiveTab = 'connected' | 'catalog' | 'models';

export type CatalogSubview =
  | { kind: 'list' }
  | { kind: 'detail'; providerId: string }
  | { kind: 'connect'; providerId: string }
  | { kind: 'custom' };

export interface ProjectProviderModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: ActiveTab;
  initialProviderId?: string;
  asPanel?: boolean;
  allowedTabs?: ActiveTab[];
  /**
   * Read-only members see connected providers + catalog but not the
   * add/connect/remove controls (which POST and would 403). Fails safe: a
   * missing value is treated as read-only.
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
