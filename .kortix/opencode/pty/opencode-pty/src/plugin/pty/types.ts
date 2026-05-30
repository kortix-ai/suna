import type { RingBuffer } from './buffer.ts'

// IPty interface from bun-pty — defined inline so we don't need a static
// import of the native module (which crashes if bun-pty isn't available).
export interface IPtyLike {
  pid: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (event: { exitCode: number; signal?: number | string }) => void) => void
  write: (data: string) => void
  kill: (signal?: string) => void
  resize?: (cols: number, rows: number) => void
}

export type PTYStatus = 'running' | 'exited' | 'killing' | 'killed'

export interface PTYSession {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  env?: Record<string, string>
  status: PTYStatus
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: string
  parentSessionId: string
  parentAgent?: string
  notifyOnExit: boolean
  buffer: RingBuffer
  process: IPtyLike | null
}

export interface PTYSessionInfo {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  status: PTYStatus
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: string
  lineCount: number
}

export interface SpawnOptions {
  command: string
  args?: string[]
  workdir?: string
  env?: Record<string, string>
  title?: string
  description?: string
  parentSessionId: string
  parentAgent?: string
  notifyOnExit?: boolean
}

export interface ReadResult {
  lines: string[]
  totalLines: number
  offset: number
  hasMore: boolean
}

export interface SearchResult {
  matches: Array<{ lineNumber: number; text: string }>
  totalMatches: number
  totalLines: number
  offset: number
  hasMore: boolean
}
