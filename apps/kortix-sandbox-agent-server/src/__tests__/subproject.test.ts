import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildOpencodeConfigContent } from '../opencode'
import {
  SUBPROJECT_CONTEXT_ENV_NAME,
  renderSubprojectInstruction,
  writeSubprojectInstruction,
} from '../subproject'

const ENVELOPE = JSON.stringify({
  version: 1,
  slug: 'marketing',
  name: 'Marketing',
  description: 'Campaign work.',
  instructions: 'Always write in British English.\n',
  context: ['docs/brand.md', '.kortix/subprojects/marketing/'],
  sessions: 'private',
})

describe('renderSubprojectInstruction', () => {
  test('renders the full guide from the API envelope', () => {
    expect(renderSubprojectInstruction(ENVELOPE)).toBe(
      [
        '# Subproject: Marketing',
        '',
        'Campaign work.',
        '',
        '## Instructions',
        '',
        'Always write in British English.',
        '',
        '## Context',
        '',
        'Read these before answering:',
        '- `docs/brand.md`',
        '- `.kortix/subprojects/marketing/`',
        '',
        'Sessions you start with `kortix sessions new` inherit this subproject unless you pass `--subproject`.',
        '',
      ].join('\n'),
    )
  })

  test('omits every empty section and falls back to the slug for the name', () => {
    const rendered = renderSubprojectInstruction(
      JSON.stringify({ version: 1, slug: 'research', context: [] }),
    )
    expect(rendered).toBe(
      '# Subproject: research\n\nSessions you start with `kortix sessions new` inherit this subproject unless you pass `--subproject`.\n',
    )
    expect(rendered).not.toContain('## Instructions')
    expect(rendered).not.toContain('## Context')
  })

  test('renders nothing for an absent, malformed, or wrong-version envelope', () => {
    expect(renderSubprojectInstruction(undefined)).toBe('')
    expect(renderSubprojectInstruction('')).toBe('')
    expect(renderSubprojectInstruction('{not json')).toBe('')
    expect(renderSubprojectInstruction(JSON.stringify({ version: 2, slug: 'x' }))).toBe('')
    expect(renderSubprojectInstruction(JSON.stringify({ version: 1 }))).toBe('')
  })
})

describe('writeSubprojectInstruction', () => {
  test('writes the guide and returns its path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kortix-subproject-')), 'subproject.md')
    expect(writeSubprojectInstruction({ [SUBPROJECT_CONTEXT_ENV_NAME]: ENVELOPE }, path)).toBe(path)
    expect(readFileSync(path, 'utf8')).toContain('# Subproject: Marketing')
  })

  test('writes no file at all for a session with no subproject', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kortix-subproject-')), 'subproject.md')
    expect(writeSubprojectInstruction({}, path)).toBeNull()
    expect(writeSubprojectInstruction({ [SUBPROJECT_CONTEXT_ENV_NAME]: '{oops' }, path)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })
})

describe('buildOpencodeConfigContent — subproject instructions', () => {
  test('appends the subproject guide after the project and secret instructions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-subproject-cfg-'))
    const secretFile = join(dir, 'capabilities.md')
    const subprojectFile = join(dir, 'subproject.md')
    writeFileSync(secretFile, '# Secret capabilities\n')
    writeFileSync(subprojectFile, '# Subproject: Marketing\n')

    const content = await buildOpencodeConfigContent(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['/workspace/AGENTS.md'] }) },
      {
        secretCapabilitiesInstructionPath: secretFile,
        subprojectInstructionPath: subprojectFile,
      },
    )
    expect(JSON.parse(content!).instructions).toEqual([
      '/workspace/AGENTS.md',
      secretFile,
      subprojectFile,
    ])
  })

  test('never duplicates a path the compiled config already declares', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-subproject-cfg-'))
    const subprojectFile = join(dir, 'subproject.md')
    writeFileSync(subprojectFile, '# Subproject: Marketing\n')

    const content = await buildOpencodeConfigContent(
      {
        KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({
          instructions: ['docs/brand.md', subprojectFile],
          agent: {},
        }),
      },
      { subprojectInstructionPath: subprojectFile },
    )
    expect(JSON.parse(content!).instructions).toEqual(['docs/brand.md', subprojectFile])
  })

  test('a missing subproject file contributes no instructions key', async () => {
    const content = await buildOpencodeConfigContent(
      {},
      { subprojectInstructionPath: '/nonexistent-subproject.md' },
    )
    expect(JSON.parse(content!).instructions).toBeUndefined()
  })
})
