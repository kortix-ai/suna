import * as P from '../rest/projects-client';

import type { SessionBindingContext } from './session-context';
import type { SessionModel } from './session-shared';
export function bindSessionActionsResources(ctx: SessionBindingContext) {
  return {
    // ── agent actions (opinionated wrappers over the runtime) ────────────
    // These do the right thing end-to-end for scripts/non-React hosts: ensure
    // the runtime is up, resolve the OpenCode session id, and act through a
    // client bound to THIS handle's own runtime URL (never the module-global
    // "active" one, so parallel handles on different sandboxes never cross
    // wires). React hosts use `@kortix/sdk/react` hooks instead, which bind to
    // the same resolved id reactively (see the white-label reference app).
    /** Pick the model `send` will use for subsequent prompts (until changed). */
    setModel: (model: SessionModel | undefined) => {
      ctx.model = model;
    },
    /**
     * PERSIST a new model for this session server-side, re-pointing the
     * running sandbox. Distinct from `setModel`, which only chooses what the
     * NEXT local `send` asks for and never leaves this handle.
     *
     * Restarting the runtime is how the change takes effect, so an in-flight
     * turn ends. `applied_live` reports whether a running session took it now
     * or whether it applies at next start.
     */
    changeModel: async (model: string) => {
      const result = await P.setProjectSessionModel(ctx.projectId, ctx.sessionId, model);
      ctx.clearPersistedDefaults();
      return result;
    },
  };
}
