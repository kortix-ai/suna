import type { KortixEvent, KortixEventBus } from '../../kortix-event-bus'

/** Frames whose payload names a session, and where. */
function sessionOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  if (typeof p.sessionID === 'string') return p.sessionID
  const info = p.info as { sessionID?: unknown; id?: unknown } | undefined
  if (info && typeof info.sessionID === 'string') return info.sessionID
  const part = p.part as { sessionID?: unknown } | undefined
  if (part && typeof part.sessionID === 'string') return part.sessionID
  return undefined
}

/** An OpenCode SSE frame, verbatim. */
  export function publishOpenCodeEvent(bus: KortixEventBus, event: { type?: string; properties?: unknown }): KortixEvent | null {
    if (!event || typeof event.type !== 'string' || event.type.length === 0) return null
    return bus.publish(event.type, event.properties ?? {}, sessionOf(event.properties))
  }

export const OPENCODE_EVENT_RECOVERY = [
  "GET /kortix/opencode/state",
  "GET /kortix/opencode/messages/:sessionId?limit=20",
] as const
