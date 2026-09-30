/** Types shared by the session-open orchestrator and its phase modules. */
import type { sessionSandboxes } from '@kortix/db';
import type { SandboxStatus } from '../../platform/providers';
import type { StartCallLog } from '../session-lifecycle/start-envelope';
import type { ProjectRow } from '../lib/serializers';

/** The sandbox row the open resolves. `undefined` until the row select ran. */
export type OpenSessionRow = typeof sessionSandboxes.$inferSelect;

/**
 * An established row: past the usable and provisioning gates the row
 * carries its external_id, and every later phase reads it as set.
 */
export type OpenSessionRowWithExternalId = OpenSessionRow & { externalId: string };

/** The one open call signature — verbatim from the former `runOpenSession`. */
export type OpenSessionArgs = {
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      opencodeSessionId: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
};

/** What {@link openSession}'s provider observation hands to the later phases. */
export type ObservedProvider = {
  provider: ReturnType<typeof import('../../platform/providers').getProvider>;
  providerStatus: SandboxStatus;
};
