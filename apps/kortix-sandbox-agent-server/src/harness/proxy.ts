import type { Config } from '../config'
import type { SandboxBootState } from '../boot-state'

export type HarnessReadiness =
  | { ready: true }
  | { ready: false; phase: string; details: Record<string, unknown> }

/** Parsed input to the native compatibility client, not a server request. */
export interface HarnessForwardInput {
  method: string
  path: string
  search: string
  headers: Headers
  body?: ReadableStream<Uint8Array> | null
}

export interface HarnessForwardResult {
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | string | null
}

/** Native upstream behavior; the host owns routing and HTTP/SSE delivery. */
export interface HarnessProxyService {
  blockedPorts(cfg: Config): readonly number[]
  readiness(context: { cfg: Config; bootState: SandboxBootState }): Promise<HarnessReadiness>
  forward(input: HarnessForwardInput): Promise<HarnessForwardResult>
}
