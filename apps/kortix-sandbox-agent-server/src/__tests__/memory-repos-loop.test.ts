/**
 * The memory loop end to end, on real git: a session clones the memory repo,
 * writes with the `memory` tool, the write is pushed, and a second session's
 * boot loads it. Also: the first session imports the project's in-repo memory
 * into a new company repo, and two sessions writing at once either both land
 * (rebase) or the loser is told to reconcile (conflict).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryTool } from '@/harness/pi/kortix-memory-tool'
import { commitAndPushMemory, setupMemoryRepos } from '@/services/memory/memory-repos'

const root = mkdtempSync(join(tmpdir(), 'kortix-memory-loop-'))
const remote = join(root, 'company.git')
const workspace = join(root, 'workspace')
const SESSION_URL = 'https://app.example.test/projects/p1/sessions/s1'
const env = {
  KORTIX_MEMORY_REPOS: JSON.stringify([{ name: 'company', url: remote, label: 'company memory' }]),
  KORTIX_FRONTEND_URL: 'https://app.example.test',
  KORTIX_PROJECT_ID: 'p1',
  KORTIX_SESSION_ID: 's1',
}
const savedEnv: Record<string, string | undefined> = {}
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Kortix Test',
  GIT_AUTHOR_EMAIL: 'test@kortix.invalid',
  GIT_COMMITTER_NAME: 'Kortix Test',
  GIT_COMMITTER_EMAIL: 'test@kortix.invalid',
}

function remoteFile(path: string): string {
  return execFileSync('git', ['--git-dir', remote, 'show', `main:${path}`], { encoding: 'utf8' })
}

async function boot(name: string) {
  const home = join(root, name)
  const instructionPath = join(root, `${name}-memory.md`)
  const ready = await setupMemoryRepos({ env, workspace, workspaceReady: Promise.resolve(), home, instructionPath })
  const tool = createMemoryTool(workspace, home)
  const run = async (args: Record<string, unknown>) => {
    const result = await tool.execute('call', args as never)
    return (result.content[0] as { text: string }).text
  }
  return { ready, instruction: () => readFileSync(instructionPath, 'utf8'), run }
}

beforeAll(() => {
  for (const [key, value] of Object.entries(IDENTITY)) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
  mkdirSync(join(workspace, 'memory'), { recursive: true })
  writeFileSync(join(workspace, 'memory', 'MEMORY.md'), '# Memory: Acme\n\n- Acme sells anvils\n\n## Index\n- [[team]]\n')
  writeFileSync(join(workspace, 'memory', 'team.md'), '- Priya owns pricing\n')
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('memory repo loop', () => {
  test('write, push, and a second session loads it; races rebase or conflict', async () => {
    // Session A creates the company repo from the in-repo memory folder.
    const a = await boot('a')
    expect(a.ready).toEqual(['company'])
    expect(remoteFile('team.md')).toBe('- Priya owns pricing\n')
    expect(a.instruction()).toContain('- Acme sells anvils')
    expect(a.instruction()).toContain(`[source: ${SESSION_URL}; added: YYYY-MM-DD]`)

    const fact = `- Deploys go out at 10:00 UTC [source: ${SESSION_URL}; added: 2026-10-07]`
    const wrote = await a.run({ command: 'str_replace', path: 'memory/company/MEMORY.md', old_str: '- Acme sells anvils', new_str: `- Acme sells anvils\n${fact}` })
    expect(wrote).toContain('Committed and pushed.')
    expect(remoteFile('MEMORY.md')).toContain(fact)

    // Session B boots after the write and has it in context.
    const b = await boot('b')
    expect(b.instruction()).toContain(fact)

    // Writes outside a repo are refused before touching disk.
    expect(await b.run({ command: 'create', path: 'memory/notes.md', file_text: 'x' })).toContain('memory paths start with')

    // A pushes again; B is behind but touched another file, so its push rebases and lands.
    expect(await a.run({ command: 'create', path: 'memory/company/customers.md', file_text: '- Big Co renews in March\n' })).toContain('Committed and pushed.')
    expect(await b.run({ command: 'insert', path: 'memory/company/team.md', insert_line: 1, insert_text: '- Sam owns support' })).toContain('Committed and pushed.')
    expect(remoteFile('customers.md')).toContain('Big Co')
    expect(remoteFile('team.md')).toContain('- Sam owns support')

    // A write that lands on a remote another session just moved applies on top of it.
    expect(await a.run({ command: 'str_replace', path: 'memory/company/team.md', old_str: '- Priya owns pricing', new_str: '- Priya owns pricing and billing' })).toContain('Committed and pushed.')
    expect(await b.run({ command: 'view', path: 'memory/company/team.md' })).toContain('- Sam owns support')
    expect(await b.run({ command: 'str_replace', path: 'memory/company/team.md', old_str: 'and billing', new_str: 'and invoicing' })).toContain('Committed and pushed.')

    // Truly simultaneous edits of one line: the push loses, and B is told to reconcile.
    const other = join(root, 'other')
    execFileSync('git', ['clone', '--quiet', remote, other])
    writeFileSync(join(other, 'team.md'), '- Priya owns pricing and refunds\n- Sam owns support\n')
    execFileSync('git', ['-C', other, 'commit', '--quiet', '-am', 'edit'])
    execFileSync('git', ['-C', other, 'push', '--quiet', 'origin', 'main'])
    const bDir = join(root, 'b', 'memory', 'company')
    writeFileSync(join(bDir, 'team.md'), '- Lee owns pricing\n- Sam owns support\n')
    const clash = await commitAndPushMemory(bDir, ['team.md'], 'edit team.md')
    expect(clash.ok).toBe(false)
    expect(clash.ok ? '' : clash.message).toContain('Not saved')
    expect(clash.ok ? '' : clash.message).toContain('+- Lee owns pricing')
    expect(readFileSync(join(bDir, 'team.md'), 'utf8')).toContain('and refunds')
    expect(remoteFile('team.md')).not.toContain('Lee')
  })
})
