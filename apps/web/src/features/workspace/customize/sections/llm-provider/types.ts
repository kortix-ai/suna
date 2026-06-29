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
}

export interface CustomFormState {
  providerId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
  modelName: string;
}

export type ChatGptPhase = 'idle' | 'waiting' | 'done';

export type ChatGptChallenge = { url: string; code: string | null };
