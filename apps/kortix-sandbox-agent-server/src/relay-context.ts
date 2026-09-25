import { logger } from './logger'

/**
 * The control-plane callback context every daemon relay reads from the sandbox
 * env: which project and session this box serves, the credential it calls back
 * with, and the API's `/v1` root.
 *
 * One reader, so the relays cannot disagree about the URL. Nine copies used to
 * exist (OpenCode boot, background, pi, and the timeline and projection relays)
 * and six of them stripped only ONE trailing slash, so
 * `KORTIX_API_URL=https://api/v1//` became `https://api/v1//v1` in those six.
 *
 * The credential is the sandbox token (`KORTIX_TOKEN`). The API accepts it on
 * every sandbox-identity route these relays call (turn stream, turn begin,
 * questions, audit events, boot timeline, runtime projection).
 */
export interface ControlPlaneEnv {
  projectId: string | null
  sessionId: string | null
  token: string | null
  /** `KORTIX_API_URL` with trailing slashes removed and `/v1` appended once. */
  apiRoot: string | null
}

export interface SandboxRelayContext {
  projectId: string
  sessionId: string
  token: string
  apiRoot: string
}

export function readControlPlaneEnv(): ControlPlaneEnv {
  const apiUrl = process.env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
  return {
    projectId: process.env.KORTIX_PROJECT_ID?.trim() || null,
    sessionId: process.env.KORTIX_SESSION_ID?.trim() || null,
    token: process.env.KORTIX_TOKEN?.trim() || null,
    apiRoot: apiUrl ? (apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`) : null,
  }
}

let warnedMissing = false

/** The full context, or null when any of the four fields is missing. A daemon
 *  with no control plane (self-host, local dev) relays nothing; the first miss
 *  logs which fields are absent, once per process. */
export function sandboxRelayContext(): SandboxRelayContext | null {
  const { projectId, sessionId, token, apiRoot } = readControlPlaneEnv()
  if (projectId && sessionId && token && apiRoot) return { projectId, sessionId, token, apiRoot }
  if (!warnedMissing) {
    warnedMissing = true
    logger.warn('[relay] control-plane env incomplete; relays to apps/api are off', {
      hasProject: !!projectId, hasSession: !!sessionId, hasToken: !!token, hasApi: !!apiRoot,
    })
  }
  return null
}

/**
 * The out-of-band channel this session belongs to — Slack or Teams — or null
 * for a dashboard session. The API projects the channel into the sandbox env on
 * every (re)provision (`SLACK_THREAD_TS` / `SLACK_CHANNEL_ID` for Slack,
 * `MS_TEAMS_CONVERSATION_ID` / `MS_TEAMS_TENANT_ID` for Teams), so the env IS
 * the session metadata.
 *
 * It gates RELEASING a blocking `question` tool call: in a channel the answer
 * arrives as a new turn, so the call must end; on the dashboard the UI answers
 * over the runtime's own event stream, so it must keep blocking. Reading only
 * the Slack keys once left every Teams question hanging.
 */
export function sessionChannel(): 'Slack' | 'Teams' | null {
  if (process.env.MS_TEAMS_CONVERSATION_ID || process.env.MS_TEAMS_TENANT_ID) return 'Teams'
  if (process.env.SLACK_THREAD_TS || process.env.SLACK_CHANNEL_ID) return 'Slack'
  return null
}
