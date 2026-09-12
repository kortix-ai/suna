import { readFile, readdir } from 'node:fs/promises'
import {
  evaluatePressure,
  type PressureFinding,
  type ResourceSnapshot,
} from '../../resources'

/** Pids whose /proc/<pid>/cmdline mentions `opencode`. Linux only; [] elsewhere. */
export async function findOpencodePids(): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const pids: number[] = []
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        const cmd = await readFile(`/proc/${e}/cmdline`, 'utf8').catch(() => null)
        if (cmd && /opencode/.test(cmd) && /\bserve\b/.test(cmd.replace(/\0/g, ' '))) pids.push(Number(e))
      }),
  )
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

export function formatOpenCodeMemoryGuardReason(snapshot: ResourceSnapshot, pct: number): string {
  return `sandbox memory at ${pct}% (opencode ${snapshot.runtime?.rssMb ?? '?'} MB RSS of ` +
    `${snapshot.cgroup.maxMb ?? snapshot.memory.totalMb ?? '?'} MB): turn stopped before the kernel would kill opencode`
}

export function formatOpenCodeResourceState(state: string | null): Record<string, unknown> {
  return { opencodeState: state }
}

export function formatOpenCodeResourceTransition(from: string, to: string): string {
  return `opencode ${from || '?'} -> ${to}`
}
