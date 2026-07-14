/** Retained only for `ProjectProviderModalProps` call-site compat — the
 *  Models page has no tabs, so these no longer select anything. */
export type ActiveTab = 'connected' | 'catalog' | 'models';

export interface ProjectProviderModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** @deprecated no-op — the Models page has no tabs. Kept so existing call
   *  sites (gateway-view.tsx, use-model-connection-gate.tsx) keep compiling. */
  defaultTab?: ActiveTab;
  /** @deprecated no-op — no call site passes this today. */
  initialProviderId?: string;
  asPanel?: boolean;
  /** @deprecated no-op — the Models page has no tabs. */
  allowedTabs?: ActiveTab[];
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
