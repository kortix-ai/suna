export interface WarmProjectSessionRecord {
  sessionId: string;
  status: string;
  baseRef: string;
  agentName: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WarmProjectSessionConfiguration {
  baseRef: string;
  agentName: string;
  sandboxSlug: string;
}

export interface ClaimWarmProjectSessionConfiguration {
  sessionId: string;
  agentName?: string;
  sandboxSlug?: string;
  pendingPrompt?: Record<string, unknown>;
}

interface WarmProjectSessionMarker {
  state: 'available' | 'claimed' | 'discarded';
  sandbox_slug: string;
  created_at: string;
  claimed_at?: string;
  discarded_at?: string;
  discard_reason?: string;
}

interface WarmProjectSessionDependencies<T extends WarmProjectSessionRecord> {
  exclusive?: <R>(operation: () => Promise<R>) => Promise<R>;
  findAvailable: () => Promise<T | null>;
  create: (metadata: Record<string, unknown>) => Promise<T>;
  discard: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>;
  claim: (sessionId: string, metadata: Record<string, unknown>) => Promise<T | null>;
  now?: () => Date;
}

const REUSABLE_STATUSES = new Set([
  'queued',
  'branching',
  'provisioning',
  'running',
]);

function markerOf(metadata: Record<string, unknown> | null): WarmProjectSessionMarker | null {
  const value = metadata?.warm_session;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Partial<WarmProjectSessionMarker>;
  if (
    !['available', 'claimed', 'discarded'].includes(marker.state ?? '') ||
    typeof marker.sandbox_slug !== 'string' ||
    typeof marker.created_at !== 'string'
  ) {
    return null;
  }
  return marker as WarmProjectSessionMarker;
}

function availableMetadata(
  sandboxSlug: string,
  now: Date,
): Record<string, unknown> {
  return {
    warm_session: {
      state: 'available',
      sandbox_slug: sandboxSlug,
      created_at: now.toISOString(),
    },
  };
}

function withMarker(
  session: WarmProjectSessionRecord,
  marker: WarmProjectSessionMarker,
): Record<string, unknown> {
  return {
    ...(session.metadata ?? {}),
    warm_session: marker,
  };
}

function compatible(
  session: WarmProjectSessionRecord,
  configuration: WarmProjectSessionConfiguration,
): boolean {
  const marker = markerOf(session.metadata);
  return (
    marker?.state === 'available' &&
    REUSABLE_STATUSES.has(session.status) &&
    session.baseRef === configuration.baseRef &&
    session.agentName === configuration.agentName &&
    marker.sandbox_slug === configuration.sandboxSlug
  );
}

export class WarmProjectSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WarmProjectSessionError';
  }
}

export function createWarmProjectSessionCoordinator<T extends WarmProjectSessionRecord>(
  dependencies: WarmProjectSessionDependencies<T>,
) {
  const now = dependencies.now ?? (() => new Date());

  const ensureUnlocked = async (configuration: WarmProjectSessionConfiguration) => {
    const available = await dependencies.findAvailable();
    if (available && compatible(available, configuration)) {
      return { session: available, reused: true };
    }

    if (available) {
      const marker = markerOf(available.metadata);
      await dependencies.discard(
        available.sessionId,
        withMarker(available, {
          state: 'discarded',
          sandbox_slug: marker?.sandbox_slug ?? configuration.sandboxSlug,
          created_at: marker?.created_at ?? now().toISOString(),
          discarded_at: now().toISOString(),
          discard_reason: REUSABLE_STATUSES.has(available.status)
            ? 'configuration_changed'
            : 'terminal_status',
        }),
      );
    }

    try {
      const session = await dependencies.create(
        availableMetadata(configuration.sandboxSlug, now()),
      );
      return { session, reused: false };
    } catch (error) {
      const winner = await dependencies.findAvailable();
      if (winner && compatible(winner, configuration)) {
        return { session: winner, reused: true };
      }
      throw error;
    }
  };

  return {
    async ensure(configuration: WarmProjectSessionConfiguration) {
      if (dependencies.exclusive) {
        return dependencies.exclusive(() => ensureUnlocked(configuration));
      }
      return ensureUnlocked(configuration);
    },

    async claim(configuration: ClaimWarmProjectSessionConfiguration) {
      const available = await dependencies.findAvailable();
      if (!available || available.sessionId !== configuration.sessionId) {
        throw new WarmProjectSessionError(
          'The warm session is no longer available',
          'WARM_SESSION_ALREADY_CLAIMED',
          409,
        );
      }

      const marker = markerOf(available.metadata);
      const matchesAgent =
        configuration.agentName === undefined || available.agentName === configuration.agentName;
      const matchesSandbox =
        configuration.sandboxSlug === undefined ||
        marker?.sandbox_slug === configuration.sandboxSlug;
      if (!matchesAgent || !matchesSandbox) {
        throw new WarmProjectSessionError(
          'The warm session does not match the selected agent or sandbox',
          'WARM_SESSION_CONFIGURATION_MISMATCH',
          409,
        );
      }

      if (!marker || marker.state !== 'available') {
        throw new WarmProjectSessionError(
          'The warm session is no longer available',
          'WARM_SESSION_ALREADY_CLAIMED',
          409,
        );
      }

      const claimedMetadata = withMarker(available, {
        ...marker,
        state: 'claimed',
        claimed_at: now().toISOString(),
      });
      if (configuration.pendingPrompt) {
        claimedMetadata.pending_prompt = configuration.pendingPrompt;
      }
      const claimed = await dependencies.claim(available.sessionId, claimedMetadata);
      if (!claimed) {
        throw new WarmProjectSessionError(
          'The warm session is no longer available',
          'WARM_SESSION_ALREADY_CLAIMED',
          409,
        );
      }
      return claimed;
    },
  };
}
