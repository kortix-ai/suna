import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KortixToolResult } from '@kortix/api-contract/kortix-tool-card'
import { PLATFORM_TOOLS, loadTools, runTool } from '@/services/tools/host'

/**
 * The My Kortix platform tools (services/tools/platform/kortix_*.ts) at their
 * boundary: the `kortix` process. A fake `kortix` on PATH records every argv
 * and answers from a script per test, as the real CLI answers with `--json`
 * and `KORTIX_ERROR_FORMAT=json`.
 */
let bin: string
let calls: string

/** Install a fake `kortix` whose body is a POSIX `case "$*"` table. */
function fakeKortix(cases: string) {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
for a in "$@"; do case "$prev" in --file|--role|--connectors|--secrets|--apps) case "$a" in -*) echo '{"kortix_error":{"kind":"failed","message":"'"$prev"' requires a value"}}' >&2; exit 2 ;; esac ;; esac; prev="$a"; done
case "$*" in
${cases}
  *) echo '{"kortix_error":{"kind":"failed","message":"unexpected: '"$*"'"}}' >&2; exit 1 ;;
esac
`
  writeFileSync(join(bin, 'kortix'), script)
  chmodSync(join(bin, 'kortix'), 0o755)
}

const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, KORTIX_PROJECT_ID: 'proj_1' })
const run = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(await runTool({ ...PLATFORM_TOOLS[name]!, name }, args, { sessionId: 'ses_1', agent: 'meta', directory: bin, env: env(), signal: new AbortController().signal })) as KortixToolResult
const argvs = () => readFileSync(calls, 'utf8').trim().split('\n')

const ROSTER = `'access ls --json') echo '{"can_manage":false,"members":[{"user_id":"u_sam","name":"Sam","account_role":"member","effective_project_role":"manager"},{"user_id":"u_ada","email":"ada@example.com","account_role":"owner","effective_project_role":"manager"},{"user_id":"u_me","name":"Lee","account_role":"member","effective_project_role":"member"}],"group_access":[]}' ;;`

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'platform-tools-'))
  calls = join(bin, 'calls.log')
  writeFileSync(calls, '')
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

describe('loading', () => {
  test('a project without a tools key never gets the platform tools; the My Kortix config names them', async () => {
    const plain = (await loadTools(null, undefined)).tools.map((tool) => tool.name)
    expect(plain.some((name) => name.startsWith('kortix_'))).toBe(false)
    const named = (await loadTools(null, { kortix_tools: ['kortix_agents', 'kortix_usage'] })).tools.map((tool) => tool.name)
    expect(named).toContain('kortix_agents')
    expect(named).toContain('kortix_usage')
    expect(named).not.toContain('kortix_people')
  })
})

describe('kortix_agents', () => {
  test('list: one row per agent, with its description and its page', async () => {
    fakeKortix(`'agents ls --json') echo '{"agents":[{"name":"researcher","model":"kimi","description":"Digs into a topic"},{"name":"mykortix","builtin":true}]}' ;;`)
    const result = await run('kortix_agents', { action: 'list' })
    expect(result.ok).toBe(true)
    expect(result.card.title).toBe('2 agents')
    expect(result.card.rows?.[0]).toEqual({ title: 'researcher', detail: 'Digs into a topic', href: '/projects/proj_1/customize/agents/researcher' })
    expect(result.card.rows?.[1]?.badge).toBe('built in')
    // My Kortix has no agent page (the project home starts it): its row links nowhere.
    expect(result.card.rows?.[1]?.href).toBeUndefined()
  })

  test('create: sends the whole block in a file (the CLI refuses `--file -`) and shows every new setting', async () => {
    fakeKortix(`'agents config writer --json') echo '{"kortix_error":{"kind":"failed","status":404,"message":"No agent writer"}}' >&2; exit 1 ;;
  'agents config writer --file '*' --json') cp "$5" ${JSON.stringify(join('$BIN', 'stdin.json'))}; echo '{"ok":true,"agent":"writer","block":{"description":"Writes posts","behavior":{"prompt":"You write."},"connectors":["gmail"]}}' ;;`.replaceAll('$BIN', bin))
    const result = await run('kortix_agents', { action: 'create', name: 'writer', description: 'Writes posts', instructions: 'You write.', connectors: ['gmail'] })
    expect(result.card.title).toBe('Created writer')
    // The PUT schema has no top-level `description`: it lives in `behavior` with the prompt.
    expect(JSON.parse(readFileSync(join(bin, 'stdin.json'), 'utf8'))).toEqual({ behavior: { prompt: 'You write.', description: 'Writes posts' }, connectors: ['gmail'] })
    expect(result.card.changes).toContainEqual({ field: 'connectors', before: null, after: 'gmail' })
  })

  test('update sends back only the keys the PUT accepts, and shows what changed', async () => {
    fakeKortix(`'agents config writer --json') echo '{"block":{"file":"agents/writer.md","tools":"all","network_egress":{"version":1},"behavior":{"prompt":"Old.","description":"Writes posts"},"opencode":{"prompt":"Old.","description":"Writes posts"}}}' ;;
  'agents config writer --file '*' --json') cp "$5" ${JSON.stringify(join('$BIN', 'sent.json'))}; echo '{"ok":true,"agent":"writer","block":{"file":"agents/writer.md","tools":"all","behavior":{"prompt":"New.","description":"Writes posts"}}}' ;;`.replaceAll('$BIN', bin))
    const result = await run('kortix_agents', { action: 'update', name: 'writer', instructions: 'New.' })
    expect(JSON.parse(readFileSync(join(bin, 'sent.json'), 'utf8'))).toEqual({ file: 'agents/writer.md', tools: 'all', behavior: { prompt: 'New.', description: 'Writes posts' } })
    expect(result.card.changes).toEqual([{ field: 'prompt', before: 'Old.', after: 'New.' }])
  })

  test('a refusal names who can grant it, read from the project members', async () => {
    fakeKortix(`'agents config writer --json') echo '{"block":{"description":"x"}}' ;;
  'agents config writer --file '*' --json') echo '{"kortix_error":{"kind":"denied","status":403,"code":"forbidden","action":"project.agent.update"}}' >&2; echo '{"kortix_error":{"kind":"failed","status":403,"message":"Forbidden"}}' >&2; exit 1 ;;
  ${ROSTER}`)
    const result = await run('kortix_agents', { action: 'update', name: 'writer', description: 'y' })
    expect(result.ok).toBe(false)
    expect(result.card.status).toBe('denied')
    expect(result.error?.kind).toBe('denied')
    expect(result.error?.message).toContain('project.agent.update')
    expect(result.error?.grantors).toEqual([
      { name: 'Sam', role: 'project manager' },
      { name: 'ada@example.com', role: 'owner' },
    ])
    expect(result.card.subtitle).toBe('Sam, ada@example.com can grant it.')
  })
})

describe('kortix_connectors', () => {
  test('connect: the sign-in link is the card action and the person must act', async () => {
    fakeKortix(`'connectors connect gmail --owner me') echo 'Open this link to sign in: https://auth.example.com/connect?x=1' ;;`)
    const result = await run('kortix_connectors', { action: 'connect', slug: 'gmail' })
    expect(result.card.status).toBe('needs_you')
    expect(result.card.links).toEqual([{ label: 'Sign in', href: 'https://auth.example.com/connect?x=1' }])
  })
})

describe('kortix_schedules', () => {
  test('create without an agent is a reminder to this session; with one, each run starts its session', async () => {
    fakeKortix(`'triggers add Check the report --runtime --in 2h') echo 'trigger.abc123' ;;
  'triggers add Send the summary --runtime --cron 0 9 * * 1 --timezone Europe/Berlin --agent=researcher') echo 'Created trigger.def456' ;;`)
    const reminder = await run('kortix_schedules', { action: 'create', prompt: 'Check the report', in: '2h' })
    expect(reminder.card.title).toBe('Reminder set: 2h')
    expect(reminder.data).toMatchObject({ id: 'trigger.abc123', agent: null })
    const weekly = await run('kortix_schedules', { action: 'create', prompt: 'Send the summary', cron: '0 9 * * 1', timezone: 'Europe/Berlin', agent: 'researcher' })
    expect(weekly.data).toMatchObject({ id: 'trigger.def456', agent: 'researcher' })
    expect(argvs()).toHaveLength(2)
  })

  test('an option-shaped id never reaches the CLI, so pause cannot fall through to the project-wide switch (CWE-88)', async () => {
    fakeKortix(`'triggers pause') echo 'paused every trigger' ;;`)
    for (const id of ['--project', '-h', 'a b']) {
      const result = await run('kortix_schedules', { action: 'pause', id })
      expect(result.error?.kind).toBe('invalid')
    }
    const prompt = await run('kortix_schedules', { action: 'create', prompt: '--help', in: '2h' })
    expect(prompt.error?.message).toContain('cannot start with "-"')
    expect((await run('kortix_sessions', { action: 'stop', session_id: '--all' })).error?.kind).toBe('invalid')
    expect((await run('kortix_agents', { action: 'get', name: '--file' })).error?.kind).toBe('invalid')
    expect((await run('kortix_connectors', { action: 'find', query: '--limit' })).error?.kind).toBe('invalid')
    expect((await run('kortix_people', { action: 'invite', email: '--role' })).error?.kind).toBe('invalid')
    expect(readFileSync(calls, 'utf8')).toBe('')
  })

  test('message text that starts with "-" goes as --prompt=<text>, never as an option', async () => {
    fakeKortix(`'sessions chat ses_2 --prompt=- first point --queue') echo 'queued' ;;`)
    const sent = await run('kortix_sessions', { action: 'message', session_id: 'ses_2', text: '- first point' })
    expect(sent.ok).toBe(true)
  })

  test('create with no schedule is refused before any command runs', async () => {
    fakeKortix('')
    const result = await run('kortix_schedules', { action: 'create', prompt: 'x' })
    expect(result.error?.kind).toBe('invalid')
    expect(readFileSync(calls, 'utf8')).toBe('')
  })
})

describe('kortix_people and kortix_access', () => {
  test('set_role resolves a person by email and shows the role change', async () => {
    fakeKortix(`${ROSTER}
  'access grant u_ada --role member') echo 'ok' ;;`)
    const result = await run('kortix_people', { action: 'set_role', who: 'ADA@example.com', role: 'member' })
    expect(result.card.title).toBe('ada@example.com is now member')
    expect(result.card.changes).toEqual([{ field: 'role', before: 'owner', after: 'member' }])
  })

  test('who_can_grant lists the managers', async () => {
    fakeKortix(ROSTER)
    const result = await run('kortix_access', { action: 'who_can_grant' })
    expect(result.card.rows?.map((row) => row.title)).toEqual(['Sam', 'ada@example.com'])
  })
})

describe('kortix_usage', () => {
  test('summary reads this project\'s usage, speaks in credits and never converts a price itself', async () => {
    fakeKortix(`'billing costs --project proj_1 --since '*' --json') echo '{"totals":{"total_cost":12.5},"credits":{"total":"1,250","previous":"900","llm":"1,000","compute":"250"}}' ;;`)
    const result = await run('kortix_usage', { action: 'summary', days: 7 })
    expect(result.card.title).toBe('1,250 credits in the last 7 days')
    expect(result.card.rows).toEqual([
      { title: 'AI models', detail: '1,000 credits' },
      { title: 'Computers', detail: '250 credits' },
    ])
    expect(JSON.stringify(result.card)).not.toContain('$')
  })
})
