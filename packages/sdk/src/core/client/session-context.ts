import type { ResolvedPreviewOptions } from '../session/preview-options';
import type { SessionRuntimeEntry } from '../session/session-runtime-registry';
import type { SessionModel } from './session-shared';
export type SessionBindingContext = {
  projectId: string;
  sessionId: string;
  ensureReady: (opts?: { readyTimeoutMs?: number }) => Promise<SessionRuntimeEntry>;
  tryResolveReady: () => SessionRuntimeEntry | null;
  requireReady: (action: string) => SessionRuntimeEntry;
  forgetReady: () => void;
  resolvePreviewOptsForSandbox: (sandboxId: string) => ResolvedPreviewOptions;
  model: SessionModel | undefined;
  agent: string | undefined;
  clearPersistedDefaults: () => void;
  persistedPromptDefaults: () => Promise<{ model?: SessionModel; agent?: string }>;
};
