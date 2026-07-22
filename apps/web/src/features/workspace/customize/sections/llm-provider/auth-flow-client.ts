/**
 * Thin client for the ACCOUNT-door auth flows (spec §6.3 / §10.2 Step 5).
 *
 * Wired to the Step-3 credential routes (committed `845d0ec54`, live on the
 * running stack), all project-scoped and auth-gated:
 *   POST /projects/:projectId/oauth-credentials/:providerId/start  { sharing? }
 *   POST /projects/:projectId/oauth-credentials/:providerId/poll   { flow_id }
 *   GET  /projects/:projectId/auth-providers/:providerId/status?door=…
 *
 * This is the ONE file the door-flow route wiring lives in — the camelCase
 * shape every caller in this feature consumes is fixed here, so a route change
 * (a rename, an envelope change) touches nothing else. Calls go through the
 * web `backendApi` (which returns `{ data, error, success }` and never throws
 * on an HTTP error), so a paste-token provider's deliberate 400 (Anthropic —
 * spec: "render the paste form, POST to /secrets, no start call") surfaces as
 * a thrown error the account door already routes around by rendering the paste
 * form directly instead of calling `startAccountFlow`.
 */
import { backendApi } from '@/lib/api-client';

interface OAuthStartResponse {
  flow_id: string;
  verification_url: string;
  user_code: string | null;
  expires_at: number;
  interval_ms: number;
}

type OAuthPollResponse =
  | { status: 'pending'; next_poll_ms?: number }
  | {
      status: 'success';
      credential: { provider_id: string; expires_in_ms: number | null; updated_at: string };
    }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

/** Normalized start challenge — camelCase, browserless-friendly (a link + a
 *  code to type), never a fake localhost redirect dance (spec §6.5). */
export interface AccountFlowStart {
  flowId: string;
  /** The provider's device-authorization page the user opens themselves. */
  verificationUrl: string;
  /** The short code to enter there, when the provider issues one. */
  userCode: string | null;
  /** Epoch ms the challenge expires — the poll loop's hard deadline. */
  expiresAt: number;
  /** Suggested poll cadence in ms, floored to a safe minimum. */
  intervalMs: number;
}

/** Normalized poll result. `pending` keeps the loop going; the other three are
 *  terminal and each map to exactly one UI state (spec §9.5). */
export type AccountFlowPoll =
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

/**
 * Start an account-door device-code flow for `providerId` (an
 * `AUTH_PROVIDERS_PUBLIC` id whose `flows.web[0] === 'device-code'`).
 */
export async function startAccountFlow(
  projectId: string,
  providerId: string,
): Promise<AccountFlowStart> {
  const res = await backendApi.post<OAuthStartResponse>(
    `/projects/${projectId}/oauth-credentials/${providerId}/start`,
    {},
  );
  if (res.error || !res.data) {
    // A paste-token provider answers `start` with 400 — the account door never
    // calls this for those, but fail loud rather than spin if it ever does.
    throw new Error(res.error?.message || 'Could not start authorization');
  }
  const start = res.data;
  return {
    flowId: start.flow_id,
    verificationUrl: start.verification_url,
    userCode: start.user_code,
    expiresAt: start.expires_at || Date.now() + 10 * 60_000,
    intervalMs: Math.max(2000, start.interval_ms || 3000),
  };
}

/** Poll a started account-door flow until it resolves. A transport error is
 *  treated as still-pending so a blip never aborts an in-progress sign-in. */
export async function pollAccountFlow(
  projectId: string,
  providerId: string,
  flowId: string,
): Promise<AccountFlowPoll> {
  const res = await backendApi.post<OAuthPollResponse>(
    `/projects/${projectId}/oauth-credentials/${providerId}/poll`,
    { flow_id: flowId },
  );
  if (res.error || !res.data) return { status: 'pending' };
  switch (res.data.status) {
    case 'success':
      return { status: 'success' };
    case 'expired':
      return { status: 'expired' };
    case 'failed':
      return { status: 'failed', error: res.data.error || 'Authorization failed' };
    default:
      return { status: 'pending' };
  }
}
