// Claude accounts: a Claude Pro or Max plan, connected the way a ChatGPT account
// is. Each sign-in stores one named account in the project's key list
// (provider `claude-agent`), private to the caller until they share it; list,
// share and delete it with the account secret resources client. The sign-in
// runs the unmodified `claude setup-token` on the server: the caller approves on
// claude.com and pastes the code back. No call returns the token.

import { backendApi } from '../../http/api-client';
import { type ConnectorSharing, unwrap } from './shared';

/** `GET /projects/:id/claude-subscription`. */
export interface ClaudeSubscriptionStatus {
  /** The caller can use at least one Claude account in this project: their own or one shared with them. */
  connected: boolean;
  /** How many Claude accounts the caller can use in this project. */
  accounts: number;
}

/** A finished sign-in or a stored token. */
export interface ClaudeSubscriptionConnected {
  connected: true;
  /** The account secret resource that holds the login. */
  secret_id: string;
}

/** `POST /projects/:id/claude-subscription/login/start`. */
export interface ClaudeSubscriptionLoginStart {
  flow_id: string;
  /** The claude.com page where the caller approves the sign-in. */
  authorize_url: string;
  /** ISO 8601. */
  expires_at: string;
}

/** Which Claude account a sign-in or token creates or replaces. The same fields a ChatGPT sign-in takes. */
export interface ClaudeAccountTarget {
  /** The name of a new account. */
  resourceLabel?: string;
  /** Who may use a new account. Private to the caller when absent. */
  sharing?: ConnectorSharing;
  /** Reconnect this existing account in place. Its name, access and session selections stay. */
  resourceId?: string;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/claude-subscription`;

/** Every caller shows a refused sign-in, code or token beside the control: no app-wide error report. */
const quiet = { showErrors: false } as const;

const targetBody = (target?: ClaudeAccountTarget) => ({
  ...(target?.resourceLabel === undefined ? {} : { resource_label: target.resourceLabel }),
  ...(target?.resourceId === undefined ? {} : { resource_id: target.resourceId }),
  ...(target?.sharing === undefined ? {} : { sharing: target.sharing }),
});

export async function getClaudeSubscription(projectId: string): Promise<ClaudeSubscriptionStatus> {
  return unwrap(await backendApi.get<ClaudeSubscriptionStatus>(base(projectId)));
}

/** Start a sign-in. Open `authorize_url`, approve, then pass the shown code to `completeClaudeSubscriptionLogin`. */
export async function startClaudeSubscriptionLogin(projectId: string, target?: ClaudeAccountTarget): Promise<ClaudeSubscriptionLoginStart> {
  return unwrap(await backendApi.post<ClaudeSubscriptionLoginStart>(`${base(projectId)}/login/start`, targetBody(target), quiet));
}

/** Finish a sign-in with the code claude.com showed. Rejects with `invalid_code`, `expired` or `login_failed`. */
export async function completeClaudeSubscriptionLogin(
  projectId: string,
  input: { flowId: string; code: string },
): Promise<ClaudeSubscriptionConnected> {
  return unwrap(
    await backendApi.post<ClaudeSubscriptionConnected>(`${base(projectId)}/login/complete`, {
      flow_id: input.flowId,
      code: input.code,
    }, quiet),
  );
}

/** Store a token the caller made with `claude setup-token` on their own computer, as a Claude account. */
export async function setClaudeSubscriptionToken(projectId: string, token: string, target?: ClaudeAccountTarget): Promise<ClaudeSubscriptionConnected> {
  return unwrap(await backendApi.put<ClaudeSubscriptionConnected>(`${base(projectId)}/token`, { token, ...targetBody(target) }, quiet));
}
