/**
 * Three tabs, each answering one question and owning one list:
 *
 *  - `providers` — "where do my models come from" (`ProviderConnect`): ONE
 *     flat list of providers, one key field each.
 *  - `models`    — "which of them can this project use" (`ModelsTab`).
 *  - `custom`    — "connect something that isn't in the list"
 *     (`CustomProviderForm`).
 *
 * Custom used to be a fourth section stacked under the provider list. It is a
 * different job done maybe once, by one person in a hundred, and every reader
 * who was not that person had to scroll past it — so it became a tab, which is
 * exactly what a tab is for.
 */
export type ActiveTab = 'providers' | 'models' | 'custom';

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
