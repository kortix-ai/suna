import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  test('the log is owner-only, also one an older daemon left world-readable', async () => {
    root = mkdtempSync(join(tmpdir(), 'kortix-on-boot-log-'))
    writeFileSync(join(root, 'kortix.yaml'), 'sandbox:\n  on_boot: "echo booted"\n')
    const log = join(root, 'on-boot.log')
    writeFileSync(log, '')
    chmodSync(log, 0o644)

    runSandboxOnBoot({ ...loadHostConfig({}), projectTarget: root }, log)

    for (let attempt = 0; attempt < 50 && !readFileSync(log, 'utf8').includes('booted'); attempt += 1) {
      await Bun.sleep(20)
    }
    expect(readFileSync(log, 'utf8')).toContain('booted')
    expect(statSync(log).mode & 0o777).toBe(0o600)
  })
})
