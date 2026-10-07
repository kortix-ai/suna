/**
 * The Kortix turn verbs on OpenCode: each one is the matching OpenCode REST
 * call (`prompt_async` with `?directory=` and `{providerID, modelID}`,
 * `/session/:id/abort`, `/session/:id/message/:id`, `/agent`), sent through
 * the adapter's own proxy forward so the instance guard and the stop record
 * run exactly as for a client's request.
 */
import { STEER_NO_ACTIVE_TURN_CODE } from '@kortix/api-contract/runtime-relay'
import { logger } from '@/lib/log/logger'
import type { HarnessProxyService } from '../contract/proxy'
import type { HarnessTurnResponse, HarnessTurnService, RuntimePromptInput } from '../contract/turns'
import { relaySteerRead } from '../shared/turn-relay'
import { runtimeStateStore } from './runtime-state-projection'

/** How many forwarded message ids the daemon remembers; OpenCode's own store covers older ones. */
const RECENT_PROMPT_IDS = 512

/**
 * The first OpenCode whose loop reads a user message sent during a turn at
 * the next step and does not end while one is unanswered (parent link).
 * An older loop runs it as its own turn, after the running one.
 */
const STEER_MIN_OPENCODE_VERSION = '1.18.15'

/** True when this OpenCode release can steer, null when the version is unknown. */
export function opencodeSupportsSteer(version: string | null): boolean | null {
  return version ? Bun.semver.satisfies(version, `>=${STEER_MIN_OPENCODE_VERSION}`) : null
}

/** The running OpenCode's version (`GET /global/health`, memoised by the state store). */
export const runningOpencodeVersion = async (): Promise<string | null> => (await runtimeStateStore()?.opencodeVersion()) ?? null

/**
 * Steered message ids not yet read. The first assistant message whose
 * `parentID` names one is the read: the loop answers that message now.
 * Process-wide because the event loop (boot.ts) and the turn verbs share it.
 */
const unreadSteers = new Set<string>()

/** Test seam. */
export function resetSteerWitnessForTests(): void {
  unreadSteers.clear()
}

/**
 * Relay `steer_read` once per steered id, on its first answering assistant
 * message. OpenCode parents a step on the NEWEST user message and answers
 * everything before it, so every older unread steer (the set keeps send
 * order) was read by the same step.
 */
export function observeSteerRead(event: { type?: string; properties?: unknown }): void {
  if (event.type !== 'message.updated' || unreadSteers.size === 0) return
  const info = (event.properties as { info?: { role?: unknown; parentID?: unknown; sessionID?: unknown } } | undefined)?.info
  if (info?.role !== 'assistant' || typeof info.parentID !== 'string' || typeof info.sessionID !== 'string') return
  if (!unreadSteers.has(info.parentID)) return
  for (const id of unreadSteers) {
    unreadSteers.delete(id)
    void relaySteerRead(info.sessionID, id)
    if (id === info.parentID) break
  }
}

async function call(
  proxy: Pick<HarnessProxyService, 'forward'>,
  method: string,
  path: string,
  directory: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const result = await proxy.forward({
    method,
    path,
    search: directory ? `?directory=${encodeURIComponent(directory)}` : '',
    headers: new Headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? null : new Response(JSON.stringify(body)).body,
  })
  const text = typeof result.body === 'string' ? result.body : await new Response(result.body).text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 500) }
  }
  return { status: result.status, body: parsed }
}

const segment = encodeURIComponent

export function createOpenCodeTurnService(
  proxy: Pick<HarnessProxyService, 'forward'>,
  workspace: () => string,
  version: () => Promise<string | null> = runningOpencodeVersion,
): HarnessTurnService {
  // A repeated messageID is the same prompt sent twice (a retry, a second
  // replica, a reclaimed delivery). OpenCode does not refuse it, so answer it
  // as pi does: `200 {deduplicated: true}`. `recent` covers a send still in
  // flight and one OpenCode has not listed yet; the message read covers a
  // daemon restart, because OpenCode persists the message.
  const recent = new Set<string>()
  let readFailureLogged = false
  const alreadyHeld = async (sessionId: string, messageId: string, directory: string): Promise<boolean> => {
    try {
      const read = await call(proxy, 'GET', `/session/${segment(sessionId)}/message/${segment(messageId)}`, directory)
      return read.status === 200
    } catch (err) {
      // Fail open: a missed dedupe is the old behaviour, a dropped prompt is worse.
      if (!readFailureLogged) {
        readFailureLogged = true
        logger.warn('[opencode-turns] prompt dedupe read failed; sending anyway', { err: String(err) })
      }
      return false
    }
  }

  /** True when the id was sent before; otherwise it is recorded as sent now. */
  const duplicate = async (sessionId: string, input: RuntimePromptInput, directory: string): Promise<boolean> => {
    const key = input.messageId ? `${sessionId}:${input.messageId}` : null
    if (!key) return false
    if (recent.has(key) || (await alreadyHeld(sessionId, input.messageId!, directory)) || recent.has(key)) return true
    recent.add(key)
    if (recent.size > RECENT_PROMPT_IDS) recent.delete(recent.values().next().value!)
    return false
  }

  const send = async (sessionId: string, input: RuntimePromptInput, directory: string): Promise<HarnessTurnResponse> => {
    const key = input.messageId ? `${sessionId}:${input.messageId}` : null
    let result: { status: number; body: unknown }
    try {
      result = await call(proxy, 'POST', `/session/${segment(sessionId)}/prompt_async`, directory, {
        ...(input.messageId ? { messageID: input.messageId } : {}),
        parts: input.parts,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.noReply ? { noReply: true } : {}),
      })
    } catch (err) {
      if (key) recent.delete(key)
      throw err
    }
    // `prompt_async` answers 204: accepted, the turn runs on the event stream.
    if (result.status >= 200 && result.status < 300) {
      return { status: 202, body: { message_id: input.messageId ?? null } }
    }
    // Refused: the prompt did not go in, so a retry under the same id may.
    if (key) recent.delete(key)
    return result
  }

  return {
    async prompt(sessionId, input): Promise<HarnessTurnResponse> {
      const directory = input.directory ?? workspace()
      if (await duplicate(sessionId, input, directory)) return { status: 200, body: { deduplicated: true } }
      return send(sessionId, input, directory)
    },

    // The prompt path, only while the session runs a turn: OpenCode's loop
    // reads the message at its next step (parent link, 1.18.15 and later).
    async steer(sessionId, input): Promise<HarnessTurnResponse> {
      if (opencodeSupportsSteer(await version()) === false) return { status: 501, body: { code: 'feature_not_supported' } }
      const directory = input.directory ?? workspace()
      if (await duplicate(sessionId, input, directory)) return { status: 200, body: { deduplicated: true } }
      // OpenCode's own answer (`/session/status`): busy or retry runs a turn, absent is idle.
      const status = await call(proxy, 'GET', '/session/status', directory).catch(() => null)
      const type = (status?.body as Record<string, { type?: unknown } | undefined> | null)?.[sessionId]?.type
      if (status?.status !== 200 || (type !== 'busy' && type !== 'retry')) {
        recent.delete(`${sessionId}:${input.messageId}`)
        return { status: 409, body: { code: STEER_NO_ACTIVE_TURN_CODE } }
      }
      // Recorded before the send: the answering assistant message can follow at once.
      unreadSteers.add(input.messageId!)
      if (unreadSteers.size > RECENT_PROMPT_IDS) unreadSteers.delete(unreadSteers.values().next().value!)
      const result = await send(sessionId, input, directory).catch((err) => {
        unreadSteers.delete(input.messageId!)
        throw err
      })
      if (result.status !== 202) {
        unreadSteers.delete(input.messageId!)
        return result
      }
      return { status: 202, body: { message_id: input.messageId, steered: true } }
    },
    abort: (sessionId) => call(proxy, 'POST', `/session/${segment(sessionId)}/abort`, workspace()),
    readMessage: (sessionId, messageId) =>
      call(proxy, 'GET', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace()),
    removeMessage: (sessionId, messageId) => {
      // A removed message may be sent again under its id.
      recent.delete(`${sessionId}:${messageId}`)
      return call(proxy, 'DELETE', `/session/${segment(sessionId)}/message/${segment(messageId)}`, workspace())
    },
    async agents(directory) {
      const result = await call(proxy, 'GET', '/agent', directory ?? workspace())
      if (result.status !== 200 || !Array.isArray(result.body)) return result
      return {
        status: 200,
        body: {
          agents: (result.body as Array<Record<string, unknown>>).map((agent) => ({
            name: agent.name,
            description: agent.description ?? null,
            mode: agent.mode ?? null,
          })),
        },
      }
    },
  }
}
