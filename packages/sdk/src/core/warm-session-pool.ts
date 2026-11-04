/**
 * The warm-session pool, kept only for semver.
 *
 * Warm sessions were removed on 2026-11-03. The API answers 410 to
 * `POST /projects/:id/sessions/warm` and `/warm/claim`, and sends
 * `experimental.warm_sessions: false` for every project. A session boots fast
 * enough on its own, and 66 % of the pre-created sessions were never used.
 *
 * `createWarmSessionPool` still returns a pool with the same shape, so a host
 * pinned to this major keeps compiling. That pool never holds a session and
 * never calls its client: `take` returns null and `prime` returns false, so
 * the host always runs its ordinary create. Every name here is removed in the
 * next major.
 */

/** @deprecated Warm sessions were removed. Removed in the next major. */
export interface WarmPoolSession {
  sessionId: string;
}

/** @deprecated Warm sessions were removed. The pool never calls this client. Removed in the next major. */
export interface WarmSessionPoolClient<Session extends WarmPoolSession, ClaimInput> {
  ensure: (projectId: string, excludeSessionId?: string) => Promise<Session>;
  claim: (projectId: string, input: ClaimInput) => Promise<unknown>;
  read: (projectId: string, sessionId: string) => Promise<{ metadata?: unknown } | null>;
}

/** @deprecated Warm sessions were removed. Removed in the next major. */
export interface WarmSessionPoolCoreOptions<Session extends WarmPoolSession, Send> {
  fits: (session: Session, send: Send) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** @deprecated Warm sessions were removed. Removed in the next major. */
export interface WarmSessionPoolCore<Session extends WarmPoolSession, Send, ClaimInput> {
  /** Does nothing. */
  ensure: (projectId: string, options?: { excludeSessionId?: string }) => Promise<void>;
  /** Always null: run the ordinary create. */
  take: (projectId: string, send: Send, options: { replenish: boolean }) => Session | null;
  /** Always false: run the ordinary create. */
  prime: (projectId: string, session: Session, input: ClaimInput) => Promise<boolean>;
  /** Always null. */
  dropBySessionId: (sessionId: string) => string | null;
  /** Always false. */
  revalidate: (projectId: string) => Promise<boolean>;
  /** Always null. */
  held: (projectId: string) => Session | null;
  /** Does nothing. */
  reset: () => void;
  /** Resolves at once. */
  settled: () => Promise<void>;
}

/**
 * @deprecated Warm sessions were removed (2026-11-03). Returns a pool that
 * never holds a session and never calls `client`. Removed in the next major.
 */
export function createWarmSessionPool<Session extends WarmPoolSession, Send, ClaimInput>(
  _client: WarmSessionPoolClient<Session, ClaimInput>,
  _options: WarmSessionPoolCoreOptions<Session, Send>,
): WarmSessionPoolCore<Session, Send, ClaimInput> {
  return {
    ensure: async () => {},
    take: () => null,
    prime: async () => false,
    dropBySessionId: () => null,
    revalidate: async () => false,
    held: () => null,
    reset: () => {},
    settled: async () => {},
  };
}
