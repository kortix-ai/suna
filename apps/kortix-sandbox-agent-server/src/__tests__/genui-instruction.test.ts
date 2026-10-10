import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { genuiEnabled, genuiPromptSection, genuiPromptText, writeGenuiInstruction } from '@/services/sandbox-env/genui-instruction'

const dir = () => mkdtempSync(join(tmpdir(), 'genui-'))

describe('genui instruction', () => {
  test('only KORTIX_GENUI=1 enables it; missing means off', () => {
    expect(genuiEnabled({ KORTIX_GENUI: '1' })).toBe(true)
    expect(genuiEnabled({ KORTIX_GENUI: '0' })).toBe(false)
    expect(genuiEnabled({})).toBe(false)
  })

  test('flag on writes the generated prompt', () => {
    const path = join(dir(), 'genui.md')
    expect(writeGenuiInstruction({ KORTIX_GENUI: '1' }, path)).toBe(path)
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(genuiPromptText())
    expect(text).toContain('```openui')
  })

  test('flag off removes a stale file from an earlier boot', () => {
    const path = join(dir(), 'genui.md')
    writeFileSync(path, 'stale')
    expect(writeGenuiInstruction({ KORTIX_GENUI: '0' }, path)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('the prompt text is computed once', () => {
    expect(genuiPromptText()).toBe(genuiPromptText())
  })
})

describe('pi prompt section', () => {
  test('root agent with the flag on gets the catalog', () => {
    expect(genuiPromptSection({ KORTIX_GENUI: '1' }, false)).toBe(genuiPromptText())
  })
  test('subagents and flag-off sessions get nothing', () => {
    expect(genuiPromptSection({ KORTIX_GENUI: '1' }, true)).toBeNull()
    expect(genuiPromptSection({ KORTIX_GENUI: '0' }, false)).toBeNull()
  })
})
