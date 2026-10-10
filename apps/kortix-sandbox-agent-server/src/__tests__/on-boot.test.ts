import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHostConfig } from '@/lib/config/config'
import { runSandboxOnBoot } from '@/harness/shared/on-boot'

describe('sandbox on_boot', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('runs when the log file cannot be opened', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-on-boot-run-'))
    const marker = join(root, 'started')
    writeFileSync(
      join(root, 'kortix.yaml'),
      `sandbox:\n  on_boot: "printf started > ${marker}"\n`,
    )

    runSandboxOnBoot(
      { ...loadHostConfig({}), projectTarget: root },
      '/dev/null/kortix-on-boot.log',
    )

    for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) {
      await Bun.sleep(20)
    }
    expect(readFileSync(marker, 'utf8')).toBe('started')
  })
})
