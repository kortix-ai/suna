import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INITIAL_PROMPT_DELIVERED_PATH,
  initialPromptAlreadyDelivered,
  markInitialPromptDelivered,
} from '../initial-prompt'

let dir: string
let marker: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-initprompt-'))
  marker = join(dir, 'nested', 'initial-prompt-delivered')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('initial prompt delivery marker (wake-replay guard)', () => {
  test('reports not-delivered before the marker is written', () => {
    expect(initialPromptAlreadyDelivered(marker)).toBe(false)
  })

  test('marks delivery durably, creating parent dirs', () => {
    markInitialPromptDelivered(marker)
    expect(existsSync(marker)).toBe(true)
    // Stores an ISO timestamp for debuggability, not an empty file.
    expect(readFileSync(marker, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(initialPromptAlreadyDelivered(marker)).toBe(true)
  })

  test('once delivered, a later boot sees the marker and would skip replay', () => {
    // First cold boot delivers.
    expect(initialPromptAlreadyDelivered(marker)).toBe(false)
    markInitialPromptDelivered(marker)
    // Simulate a wake/reboot: same persisted disk, marker still present.
    expect(initialPromptAlreadyDelivered(marker)).toBe(true)
  })

  test('a fresh cold provision (new disk, no marker) is treated as not-delivered', () => {
    markInitialPromptDelivered(marker)
    const freshDisk = join(dir, 'fresh', 'initial-prompt-delivered')
    expect(initialPromptAlreadyDelivered(freshDisk)).toBe(false)
  })

  test('default marker path lives on the durable opencode data home, not tmpfs', () => {
    // Regression guard: the bug was the only guard living under tmpfs /var/run,
    // wiped on every reboot. The durable marker must NOT live under /var/run or
    // /tmp/-style RAM paths.
    expect(INITIAL_PROMPT_DELIVERED_PATH).not.toContain('/var/run')
    expect(INITIAL_PROMPT_DELIVERED_PATH).toContain('/opt/kortix/home')
  })

  test('marking is idempotent across repeated boots', () => {
    markInitialPromptDelivered(marker)
    const first = readFileSync(marker, 'utf8')
    expect(first.length).toBeGreaterThan(0)
    // A subsequent boot that (incorrectly) re-marks must not throw or clear it.
    markInitialPromptDelivered(marker)
    expect(initialPromptAlreadyDelivered(marker)).toBe(true)
  })

  test('writeFileSync override is observable through the public API', () => {
    // Sanity: a manually-seeded marker (e.g. migrated/restored disk) is honored.
    const seeded = join(dir, 'seeded')
    writeFileSync(seeded, '2026-01-01T00:00:00.000Z', 'utf8')
    expect(initialPromptAlreadyDelivered(seeded)).toBe(true)
  })
})
