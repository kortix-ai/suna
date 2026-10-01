import { bindSessionDefaults } from './session-defaults';
import { bindSessionReadiness } from './session-readiness';

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { bindSessionActionsResources } from './session-actions-resources';
import { bindSessionActionsSecurity } from './session-actions-security';
import { bindSessionActionsServices } from './session-actions-services';
import { bindSessionFiles } from './session-files';
import { bindSessionLifecycleResources } from './session-lifecycle-resources';
import { bindSessionLifecycleSecurity } from './session-lifecycle-security';
import { bindSessionPreview } from './session-preview';

import { getClientForUrl } from '../runtime/client';

import type { KortixPlatformConfig } from '../http/config';

import type { ResolvedPreviewOptions } from '../session/preview-options';

import type { SessionModel } from './session-shared';
/** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
export function session(
  projectId: string,
  sessionId: string,
  config: KortixPlatformConfig,
  resolvePreviewOptsForSandbox: (sandboxId: string) => ResolvedPreviewOptions,
) {
  // Opinionated-action state, scoped to THIS handle. The opencode runtime is
  // keyed by the OpenCode session id (resolved server-side at /start), NOT the
  // Kortix `sessionId` — they differ. We resolve+cache it once (including the
  // resolved runtime URL + sandbox id), and remember a chosen model so `send`
  // carries it. Every runtime-scoped operation below reads ONLY this cached
  // record — never the module-global "currently active" runtime — so two
  // session handles pointed at two different sandboxes never cross wires.
  let _model: SessionModel | undefined;
  let _agent: string | undefined;
  const { persistedPromptDefaults, clearPersistedDefaults } = bindSessionDefaults(
    projectId,
    sessionId,
  );
  const { ensureReady, tryResolveReady, requireReady, forgetReady } = bindSessionReadiness(
    projectId,
    sessionId,
    config,
  );

  const context = {
    projectId,
    sessionId,
    ensureReady,
    tryResolveReady,
    requireReady,
    forgetReady,
    resolvePreviewOptsForSandbox,
    get model() {
      return _model;
    },
    set model(value: SessionModel | undefined) {
      _model = value;
    },
    get agent() {
      return _agent;
    },
    set agent(value: string | undefined) {
      _agent = value;
    },
    clearPersistedDefaults,
    persistedPromptDefaults,
  };
  return {
    ...bindSessionLifecycleResources(context),
    ...bindSessionLifecycleSecurity(context),
    ...bindSessionPreview(context),
    ...bindSessionActionsResources(context),
    ...bindSessionActionsSecurity(context),
    ...bindSessionActionsServices(context),
    files: bindSessionFiles(ensureReady),
    get runtime(): OpencodeClient {
      return getClientForUrl(requireReady('runtime').runtimeUrl);
    },
  };
}
