/**
 * Warm sessions on mobile — the mobile adapter over the SDK pool core
 * (`@kortix/sdk` `createWarmSessionPool`).
 *
 * A session started from project home pays the whole sandbox boot after the
 * user presses Send. So while the user is present on a project (the project
 * screen is mounted AND the app is in the foreground), keep one session already
 * created for them. A send claims it with its first prompt and opens a sandbox
 * that is already up.
 *
 * A warm session is an ORDINARY session the user has not typed into yet. The
 * server hides it from the session list (`metadata.warm`) until its first
 * prompt lands, and gates it by the `warm_sessions` project flag (explicit opt-in).
 *
 * Everything the two hosts share — reserve, take, the one-retry exclude loop,
 * prime with its ambiguous-commit confirmation, revalidate, reset, settled —
 * lives in the SDK core. Mobile keeps only what is genuinely mobile: the send
 * shape (`WarmSend`), what fits it (`warmFitsSend`), and the claim input's
 * shape. Mobile has one app instance, so web's cross-tab registry is not
 * ported; the other-device case is covered the same way web covers other
 * browsers: `revalidate` re-reads the held row when the app returns to the
 * foreground.
 */
import {
  type WarmSessionPoolClient,
  type WarmSessionPoolCore,
  createWarmSessionPool as createWarmSessionPoolCore,
} from '@kortix/sdk';

export interface WarmSession {
  sessionId: string;
  /** The agent the server resolved for this session, never a sentinel. */
  agentName: string | null;
}

/** The first prompt, in the SDK's `PendingSessionPrompt` shape. */
export interface WarmPendingPrompt {
  text: string;
  agent: string | null;
  model: { providerID: string; modelID: string } | null;
  variant: string | null;
}

/** The claim input: the prompt row and the claim, one transaction. */
export interface WarmClaimInput {
  session_id: string;
  agent_name?: string;
  pending_prompt: WarmPendingPrompt;
}

export type WarmSessionClient = WarmSessionPoolClient<WarmSession, WarmClaimInput>;

/** What a project-home send asks for. */
export interface WarmSend {
  /** The agent the send names, or null for the project default. */
  agentName: string | null;
  /** A picked model (gateway id), or null for the project default. */
  model: string | null;
  hasFiles: boolean;
}

/**
 * Can this warm session serve this send? It was created with the project's
 * defaults and nothing else. Files ride the ordinary path, which delivers them
 * once the sandbox is reachable.
 */
export function warmFitsSend(warm: WarmSession, send: WarmSend): boolean {
  if (send.hasFiles) return false;
  if (send.model !== null) return false;
  if (send.agentName !== null && send.agentName !== warm.agentName) return false;
  return true;
}

/** The SDK core pool over mobile's send shape, with mobile's 4-argument prime. */
export type WarmSessionPool = Omit<
  WarmSessionPoolCore<WarmSession, WarmSend, WarmClaimInput>,
  'prime'
> & {
  /** Hand a taken session its first prompt. False: refused, run the ordinary create. */
  prime: (
    projectId: string,
    warm: WarmSession,
    prompt: WarmPendingPrompt,
    agentName: string | null,
  ) => Promise<boolean>;
};

export function createWarmSessionPool(
  client: WarmSessionClient,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): WarmSessionPool {
  const core = createWarmSessionPoolCore(client, { fits: warmFitsSend, sleep: options.sleep });
  return {
    ...core,
    // Mobile names the claim's parts — the send-time prompt and the resolved
    // agent — and the core takes the assembled transaction input.
    prime: (projectId, warm, prompt, agentName) =>
      core.prime(projectId, warm, {
        session_id: warm.sessionId,
        ...(agentName ? { agent_name: agentName } : {}),
        pending_prompt: prompt,
      }),
  };
}
