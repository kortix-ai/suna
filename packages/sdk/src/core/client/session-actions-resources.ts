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
    /** Read the server-side pin, not this handle's local send preference. */
    getModel: () => P.getWorkspaceSessionModel(ctx.projectId, ctx.sessionId),
    /** Persist a model and queue a continuation without interrupting this turn. */
    switchModel: async (input: P.SessionModelSwitchInput) => {
      const result = await P.switchWorkspaceSessionModel(ctx.projectId, ctx.sessionId, input);
      ctx.clearPersistedDefaults();
      return result;
    },
    /**
     * PERSIST a new model for this session server-side, re-pointing the
     * running sandbox. Distinct from `setModel`, which only chooses what the
     * NEXT local `send` asks for and never leaves this handle.
     *
     * Pi reconfigures without restarting. The running turn finishes on its
     * current model; the next turn uses the new settings. `applied_live`
     * reports whether the live sandbox accepted those settings.
     */
    changeModel: async (model: string) => {
      const result = await P.setWorkspaceSessionModel(ctx.projectId, ctx.sessionId, model);
      ctx.clearPersistedDefaults();
      return result;
    },
  };
}
