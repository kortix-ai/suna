/**
 * JAY-510 collapsed the old three-tab provider modal ('catalog' | 'connected' |
 * 'models') into two: `providers` is `provider-connect.tsx`'s four-section
 * surface, which already contains what 'catalog' and 'connected' used to be
 * separate tabs for. `CatalogSubview` is gone with the list -> detail -> connect
 * drill-down it described.
 */
export type ActiveTab = 'providers' | 'models';

export interface ProjectProviderModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: ActiveTab;
  /**
   * Read-only members see connected providers + the catalog but not the
   * add/connect/remove controls (which POST and would 403). Fails safe: a
   * missing value is treated as read-only.
   */
  canWrite?: boolean;
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
