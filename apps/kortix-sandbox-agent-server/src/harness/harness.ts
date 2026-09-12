/** Internal lifecycle contract. This does not define the client wire protocol. */
export type HarnessState = 'starting' | 'ok' | 'down'

export interface HarnessLifecycleService {
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  getState(): HarnessState
}

/**
 * The common surface is deliberately small. Concrete harness services expose
 * additional typed feature ports; another harness need not implement them.
 * Absence from this interface never means removing a native feature.
 */
export interface HarnessService {
  readonly id: string
  readonly lifecycle: HarnessLifecycleService
}
