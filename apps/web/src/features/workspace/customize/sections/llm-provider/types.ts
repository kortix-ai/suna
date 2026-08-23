/**
 * The dialog's two tabs — `QUICK_LLM_TABS` in `gateway-view.tsx`, aliased
 * here so the modal's prop types and the strip it renders can never name a
 * different set. Adding a tab to the dialog is one edit, in that file.
 *
 *  - `providers` — "where do my models come from" (`ProviderConnect`): ONE
 *     flat list of providers, one key field each. A key is stored as a project
 *     secret and spent by the Kortix gateway; it never enters the sandbox.
 *  - `models`    — "which of them can this project use" (`ModelsTab`).
 *
 * There is no `custom` tab. It generated an OpenCode `provider:{...}` block for
 * `.opencode/opencode.jsonc` — an OpenCode-native provider, which no session
 * can use: OpenCode sees exactly one provider, `kortix`, and the daemon strips
 * provider keys from its env. Custom OpenAI-compatible endpoints are a
 * gateway-side upstream feature, not an OpenCode config.
 */
import type { QuickLlmTab } from '@/features/workspace/customize/sections/gateway-view';

export type ActiveTab = QuickLlmTab;

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

export type ChatGptPhase = 'idle' | 'waiting' | 'done';

export type ChatGptChallenge = { url: string; code: string | null };
