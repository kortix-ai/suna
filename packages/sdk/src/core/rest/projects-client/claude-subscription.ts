// The caller's Claude subscription login: Claude Code in their sessions runs on
// their own Claude plan. The login runs the unmodified `claude setup-token` on
// the server; the caller approves on claude.com and pastes the code back. No
// call returns the token.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** `GET /projects/:id/claude-subscription`. */
export interface ClaudeSubscriptionStatus {
  /** The caller has a Claude login in the project's account. */
  connected: boolean;
  /** `setup_token`: signed in through Kortix. `pasted`: a token the caller made. */
  source: 'setup_token' | 'pasted' | null;
  /** When the login was stored (ISO 8601). */
  connected_at: string | null;
  /** False when the server cannot read the stored login: sign in again. */
  usable: boolean;
}

/** `POST /projects/:id/claude-subscription/login/start`. */
export interface ClaudeSubscriptionLoginStart {
  flow_id: string;
  /** The claude.com page where the caller approves the sign-in. */
  authorize_url: string;
  /** ISO 8601. */
  expires_at: string;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/claude-subscription`;

/** Every caller shows a refused sign-in, code or token beside the control: no app-wide error report. */
const quiet = { showErrors: false } as const;

export async function getClaudeSubscription(projectId: string): Promise<ClaudeSubscriptionStatus> {
  return unwrap(await backendApi.get<ClaudeSubscriptionStatus>(base(projectId)));
}

/** Start a sign-in. Open `authorize_url`, approve, then pass the shown code to `completeClaudeSubscriptionLogin`. */
export async function startClaudeSubscriptionLogin(projectId: string): Promise<ClaudeSubscriptionLoginStart> {
  return unwrap(await backendApi.post<ClaudeSubscriptionLoginStart>(`${base(projectId)}/login/start`, {}, quiet));
}

/** Finish a sign-in with the code claude.com showed. Rejects with `invalid_code`, `expired` or `login_failed`. */
export async function completeClaudeSubscriptionLogin(
  projectId: string,
  input: { flowId: string; code: string },
): Promise<ClaudeSubscriptionStatus> {
  return unwrap(
    await backendApi.post<ClaudeSubscriptionStatus>(`${base(projectId)}/login/complete`, {
      flow_id: input.flowId,
      code: input.code,
    }, quiet),
  );
}

/** Store a token the caller made with `claude setup-token` on their own computer. */
export async function setClaudeSubscriptionToken(projectId: string, token: string): Promise<ClaudeSubscriptionStatus> {
  return unwrap(await backendApi.put<ClaudeSubscriptionStatus>(`${base(projectId)}/token`, { token }, quiet));
}

/** Delete the caller's Claude login and remove it from their running sessions. */
export async function disconnectClaudeSubscription(projectId: string): Promise<ClaudeSubscriptionStatus> {
  return unwrap(await backendApi.delete<ClaudeSubscriptionStatus>(base(projectId), quiet));
}
