import type { Route } from './route'

export type ThreadSnapshot = {
  readonly user?: string
  readonly query?: string
  readonly location?: { readonly place: string; readonly evidence: string }
  readonly pending?: { readonly user: string; readonly question: string }
}
export type ThreadSeed = { readonly snapshot?: ThreadSnapshot; readonly users?: readonly string[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

export function threadSnapshot(value: unknown): ThreadSnapshot | undefined {
  if (!object(value)) return
  const user = text(value.user, 600), query = text(value.query, 2000)
  const place = object(value.location) ? text(value.location.place, 300) : undefined
  const evidence = object(value.location) ? text(value.location.evidence, 600) : undefined
  const pendingUser = object(value.pending) ? text(value.pending.user, 600) : undefined
  const question = object(value.pending) ? text(value.pending.question, 1000) : undefined
  if (!user && !query && !place && !pendingUser) return
  return { ...(user && query ? { user, query } : {}), ...(place && evidence ? { location: { place, evidence } } : {}), ...(pendingUser && question ? { pending: { user: pendingUser, question } } : {}) }
}

/** Only the server's synthetic user notes are eligible for restoration; the caller checks provenance. */
export function threadNote(note: string): ThreadSnapshot | undefined {
  if (!note.startsWith('<voice_thread>') || !note.endsWith('</voice_thread>')) return
  try { return threadSnapshot(JSON.parse(note.slice(14, -15)) as unknown) } catch { return }
}

/** Routing facts are committed with the user's accepted turn, never by a speculative warm-up. */
export class Thread {
  private state: ThreadSnapshot
  private readonly users: string[]
  constructor(seed: ThreadSeed = {}) {
    this.state = seed.snapshot ?? {}
    this.users = (seed.users ?? []).map((user) => user.replace(/\s*\n\s*/g, ' ').slice(0, 600))
  }
  commit(user: string, decision?: Route): void {
    // What they most likely said, when the router heard a word as misheard: later turns are routed on that (src/route.ts).
    user = (decision?.heard ?? user).replace(/\s*\n\s*/g, ' ').slice(0, 600)
    this.users.push(user)
    if (this.users.length > 6) this.users.splice(0, this.users.length - 6)
    if (decision?.need === 'clarify') this.state = { ...this.state, pending: { user, question: decision.query } }
    else if (decision && (decision.need === 'web' || decision.need === 'code') && decision.query.trim()) {
      this.state = { ...this.state, user, query: decision.query, pending: undefined }
      if (decision.card?.type === 'weather' && decision.locationEvidence)
        this.state = { ...this.state, location: { place: decision.card.place, evidence: decision.locationEvidence } }
    }
  }
  context(agent?: string): string {
    return [...this.users.map((user) => `User: ${user}`), `Resolved lookup: ${JSON.stringify(this.state)}`, agent && `Agent: ${agent.slice(0, 300)}`].filter(Boolean).join('\n')
  }
  note(): string | undefined {
    return this.state.user || this.state.location || this.state.pending ? `<voice_thread>${JSON.stringify(this.state)}</voice_thread>` : undefined
  }
}
