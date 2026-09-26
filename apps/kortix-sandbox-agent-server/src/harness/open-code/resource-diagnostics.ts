import { readFile, readdir } from 'node:fs/promises'
import {
  evaluatePressure,
  type PressureFinding,
  type ResourceSnapshot,
} from '../../resources'

/** Match executable and subcommand arguments, never arbitrary test-file paths. */
export function isOpenCodeServeCommand(cmdline: string): boolean {
  const args = cmdline.split('\0').filter(Boolean)
  const executable = args[0]?.split('/').pop()
  return (executable === 'opencode' || executable === 'opencode.exe') && args[1] === 'serve'
}

/** Pids running `opencode serve`. Linux only; [] elsewhere. */
export async function findOpencodePids(): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const pids: number[] = []
  const numericEntries = entries.filter((entry) => /^\d+$/.test(entry))
  for (let offset = 0; offset < numericEntries.length; offset += 32) {
    await Promise.all(numericEntries.slice(offset, offset + 32).map(async (e) => {
      const cmd = await readFile(`/proc/${e}/cmdline`, 'utf8').catch(() => null)
      if (cmd && isOpenCodeServeCommand(cmd)) pids.push(Number(e))
    }))
  }
  return pids.sort((a, b) => a - b)
}

export type OpenCodeResourceSnapshot = Omit<ResourceSnapshot, 'runtime' | 'runtimePids'> & {
  opencode: ResourceSnapshot['runtime']
  opencodePids: number[]
}

/** Preserve the existing diagnostic and log schema at the native boundary. */
export function projectOpenCodeResourceSnapshot(snapshot: ResourceSnapshot): OpenCodeResourceSnapshot
export function projectOpenCodeResourceSnapshot(snapshot: ResourceSnapshot | null): OpenCodeResourceSnapshot | null
export function projectOpenCodeResourceSnapshot(snapshot: ResourceSnapshot | null): OpenCodeResourceSnapshot | null {
  if (!snapshot) return null
  const { runtime, runtimePids, ...host } = snapshot
  return { ...host, opencode: runtime, opencodePids: runtimePids }
}

export function evaluateOpenCodePressure(
  snapshot: ResourceSnapshot,
  previous?: ResourceSnapshot | null,
): PressureFinding[] {
  return evaluatePressure(snapshot, previous).map((finding) =>
    finding.kind === 'runtime-duplicates'
      ? {
          kind: 'opencode-duplicates',
          detail: `${snapshot.runtimePids.length} opencode serve processes: ${snapshot.runtimePids.join(',')}`,
        }
      : finding,
  )
}

/** RAM-backed files at or above this share of memory are named in the guard's reason. */
const NAMED_SHMEM_MIN_MB = 256

export function formatOpenCodeMemoryGuardReason(snapshot: ResourceSnapshot, pct: number): string {
  // A RAM-backed /tmp was half of a 4 GiB box when the guard fired on prod
  // (2026-09-24), and the message named only OpenCode. Say what else holds it.
  const shmem = snapshot.memory.shmemMb ?? 0
  const files = shmem >= NAMED_SHMEM_MIN_MB ? `, ${shmem} MB in RAM-backed files such as /tmp,` : ''
  const largestOther = snapshot.topProcesses?.find((process) =>
    process.pid !== snapshot.runtime?.pid && process.pid !== snapshot.daemon?.pid && process.rssMb >= 256)
  const other = largestOther ? `, largest other process ${largestOther.name} ${largestOther.rssMb} MB RSS` : ''
  return `sandbox memory at ${pct}% (opencode ${snapshot.runtime?.rssMb ?? '?'} MB RSS${other}${files} of ` +
    `${snapshot.cgroup.maxMb ?? snapshot.memory.totalMb ?? '?'} MB): turn stopped to prevent a kernel OOM kill`
}

export function formatOpenCodeResourceState(state: string | null): Record<string, unknown> {
  return { opencodeState: state }
}

export function formatOpenCodeResourceTransition(from: string, to: string): string {
  return `opencode ${from || '?'} -> ${to}`
}
