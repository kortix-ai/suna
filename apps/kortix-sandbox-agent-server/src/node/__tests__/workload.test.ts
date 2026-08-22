/**
 * Proves `selectWorkloadId` reproduces `main()`'s inline branches exactly,
 * including precedence — the whole point of extracting them is that the
 * extraction is provably behaviour-neutral.
 */

import { describe, expect, test } from 'bun:test'
import { IMPLEMENTED_WORKLOADS, isClaimed, selectWorkloadId } from '../workload'

/**
 * The ORIGINAL decision, transcribed from main.ts before extraction:
 *
 *   if ((process.env.KORTIX_WARM_SEED ?? '').trim() === '1') -> runWarmSeedMode
 *   if (cfg.workload === 'monitor')                          -> runMonitorMode
 *   otherwise                                                -> session
 *
 * HONEST ABOUT WHAT THIS PROVES. These are the same three lines written twice,
 * so a transcription error would be copied into both — this is a REGRESSION
 * guard, not independent evidence. It pins the decision against future edits to
 * `selectWorkloadId` and enumerates the input space that matters (trimming,
 * case, unset vs empty, precedence). The evidence that the extraction was
 * faithful in the first place is the diff against
 * `git show main:apps/kortix-sandbox-agent-server/src/main.ts`.
 */
function originalDecision(
  cfg: { workload: string },
  env: NodeJS.ProcessEnv,
): 'session' | 'monitor' | 'warm-seed' {
  if ((env.KORTIX_WARM_SEED ?? '').trim() === '1') return 'warm-seed'
  if (cfg.workload === 'monitor') return 'monitor'
  return 'session'
}

const WORKLOAD_VALUES = ['', 'monitor', 'session', 'app', 'MONITOR', ' monitor', 'nonsense']
const WARM_SEED_VALUES = [undefined, '', '0', '1', ' 1 ', 'true', 'yes']

describe('selectWorkloadId', () => {
  test('agrees with the original inline branches across the whole input space', () => {
    const disagreements: string[] = []
    for (const workload of WORKLOAD_VALUES) {
      for (const warmSeed of WARM_SEED_VALUES) {
        const env = (warmSeed === undefined ? {} : { KORTIX_WARM_SEED: warmSeed }) as NodeJS.ProcessEnv
        const cfg = { workload }
        const got = selectWorkloadId(cfg, env)
        const want = originalDecision(cfg, env)
        if (got !== want) {
          disagreements.push(`workload=${JSON.stringify(workload)} warmSeed=${JSON.stringify(warmSeed)}: got ${got}, want ${want}`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  test('warm-seed wins over monitor', () => {
    // Precedence is load-bearing: a seed builder boots a session-less runtime
    // for snapshot capture and must never be mistaken for another workload,
    // even when the rest of its env looks like one.
    expect(selectWorkloadId({ workload: 'monitor' }, { KORTIX_WARM_SEED: '1' } as NodeJS.ProcessEnv)).toBe(
      'warm-seed',
    )
  })

  test('an unrecognized workload falls back to session, never throws', () => {
    // An older control plane that knows no workload names must keep booting
    // sessions. Failing closed here would brick a box on a rollback.
    for (const value of ['app', 'nonsense', 'MONITOR', ' monitor']) {
      expect(selectWorkloadId({ workload: value }, {} as NodeJS.ProcessEnv)).toBe('session')
    }
  })

  test('warm-seed requires exactly "1" after trimming', () => {
    expect(selectWorkloadId({ workload: '' }, { KORTIX_WARM_SEED: 'true' } as NodeJS.ProcessEnv)).toBe('session')
    expect(selectWorkloadId({ workload: '' }, { KORTIX_WARM_SEED: '0' } as NodeJS.ProcessEnv)).toBe('session')
    expect(selectWorkloadId({ workload: '' }, { KORTIX_WARM_SEED: ' 1 ' } as NodeJS.ProcessEnv)).toBe('warm-seed')
  })

  test('app is declared but not implemented by this binary', () => {
    // It is a separate Go daemon today and folds in at P4. Naming it in the id
    // union while keeping it out of IMPLEMENTED_WORKLOADS is what stops it
    // becoming a special case later.
    expect(IMPLEMENTED_WORKLOADS).not.toContain('app')
    expect([...IMPLEMENTED_WORKLOADS].sort()).toEqual(['monitor', 'session', 'warm-seed'])
  })
})

describe('isClaimed', () => {
  test('a node with no session id is unclaimed', () => {
    expect(isClaimed({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isClaimed({ KORTIX_SESSION_ID: '' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isClaimed({ KORTIX_SESSION_ID: '   ' } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('a node with a session id is claimed', () => {
    expect(isClaimed({ KORTIX_SESSION_ID: 'sess_1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  test('reads the environment live, so adoption is observable', () => {
    // Adoption rewrites process.env at runtime. A cached answer would be the
    // deriving session's — the 2026-06-10 fork-identity incident.
    const env = {} as NodeJS.ProcessEnv
    expect(isClaimed(env)).toBe(false)
    env.KORTIX_SESSION_ID = 'sess_adopted'
    expect(isClaimed(env)).toBe(true)
  })
})
