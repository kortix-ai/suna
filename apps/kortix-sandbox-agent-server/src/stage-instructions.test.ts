import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGE_INSTRUCTIONS_ENV_NAME, writeStageInstruction } from './stage-instructions'

describe('writeStageInstruction', () => {
  const path = join(tmpdir(), `kortix-stage-${process.pid}`, 'stage-instructions.md')

  test('no env → no file, null path', () => {
    expect(writeStageInstruction({}, path)).toBeNull()
    expect(writeStageInstruction({ [STAGE_INSTRUCTIONS_ENV_NAME]: '   ' }, path)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('env body → file written verbatim with a trailing newline', () => {
    const body = '# Monitoring board\n- `kortix sessions stage planning`'
    expect(writeStageInstruction({ [STAGE_INSTRUCTIONS_ENV_NAME]: body }, path)).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(`${body}\n`)
    rmSync(join(tmpdir(), `kortix-stage-${process.pid}`), { recursive: true, force: true })
  })
})
