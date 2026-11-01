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
    expect(Object.keys(PLATFORM_TOOLS)).toContain('kortix_change_requests')
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

  test('models: each model the project may run, with the exact ref a spawn takes and what it is good for; never a price', async () => {
    fakeKortix(`'models ls --json') echo '{"models":{"deepseek-v4.1-flash":{"name":"DeepSeek V4.1 Flash","provider":"kortix","enabled":true,"reasoning":false,"limit":{"context":1000000},"cost":{"input":0.1,"output":0.4},"free":true},"openai/gpt-6":{"name":"GPT-6","provider":"openai","provider_name":"OpenAI","enabled":true,"reasoning":true,"attachment":true,"limit":{"context":400000},"cost":{"input":5,"output":20}},"kimi-k3":{"name":"Kimi K3","provider":"kortix","enabled":false},"anthropic/claude-x":{"name":"Claude X","provider":"anthropic","enabled":true,"available":false}},"catalog":{"glm-6":{"availability":"plan"}},"defaultModel":"deepseek-v4.1-flash","platformFeePercent":10,"claudeSubscription":{"providerId":"claude-agent","name":"Claude","connected":true,"models":[{"id":"claude-agent/claude-opus","name":"Claude Opus","description":"Deep work","limit":{"context":200000,"output":32000},"efforts":["low","high"],"requires":"claude_subscription","connected":true}]}}' ;;`)
    const result = await run('kortix_agents', { action: 'models' })
    expect(result.ok).toBe(true)
    expect(result.card.title).toBe('3 models')
    // The default first; a model the project turned off, or one this person cannot reach, is left out.
    expect(result.card.rows).toEqual([
      { title: 'DeepSeek V4.1 Flash', detail: 'kortix/deepseek-v4.1-flash · fast · 1M context', badge: 'default' },
      { title: 'Claude Opus', detail: 'claude-agent/claude-opus · reasoning · 200k context' },
      { title: 'GPT-6', detail: 'kortix/openai/gpt-6 · reasoning · images · 400k context' },
    ])
    expect(result.data).toMatchObject({
      default: 'kortix/deepseek-v4.1-flash',
      models: [
        { id: 'kortix/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', good_for: ['fast'], context: 1000000, default: true },
        { id: 'claude-agent/claude-opus', provider: 'Claude subscription', good_for: ['reasoning'] },
        { id: 'kortix/openai/gpt-6', provider: 'OpenAI', good_for: ['reasoning', 'images'], default: false },
      ],
    })
    // No price, cost, fee or "free" reaches the model or the card.
    expect(JSON.stringify(result)).not.toMatch(/cost|price|fee|free|\$/i)
    expect(argvs()).toEqual(['models ls --json'])
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
    // Each schedule value is one --flag=value word, so it can never read as an option (CWE-88).
    fakeKortix(`'triggers add Check the report --runtime --in=2h') echo 'trigger.abc123' ;;
  'triggers add Send the summary --runtime --cron=0 9 * * 1 --timezone=Europe/Berlin --agent=researcher') echo 'Created trigger.def456' ;;`)
    const reminder = await run('kortix_schedules', { action: 'create', prompt: 'Check the report', in: '2h' })
    expect(reminder.card.title).toBe('Reminder set: in 2h')
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

  test('an id that is not exactly a runtime id or a schedule slug never reaches the CLI, so it cannot walk the request path to another endpoint (CWE-22)', async () => {
    fakeKortix(`'loops rm reminder.aaaaaaaaaaaa') echo 'Removed' ;;
  'triggers run automation.bbbbbbbbbbbb') echo 'Ran' ;;
  'triggers rm automation.bbbbbbbbbbbb') echo 'Removed' ;;`)
    const traversal = [
      'reminder./../../../../secrets/STRIPE_KEY',
      'reminder.aaaaaaaaaaaa/../../secrets/STRIPE_KEY',
      'reminder.aaaaaaaaaaaa/run',
      'reminder.aaaaaaaaaaaa?x=1',
      'reminder.aaaaaaaaaaaa%2F..',
      'reminder.AAAAAAAAAAAA',
      'reminder.aaaaaaaaaaa',
      'reminder.aaaaaaaaaaaaa',
      'trigger./../../other-project',
      'trigger.cccccccccccc/..',
      '..',
      '.',
      'weekly/../digest',
      'Weekly-Digest',
      'proj:secret',
      'a@b',
      '-x',
    ]
    for (const action of ['remove', 'pause', 'resume', 'run_now', 'delete']) {
      for (const id of traversal) {
        const result = await run('kortix_schedules', { action, id })
        expect(result.ok).toBe(false)
        expect(result.error?.kind).toBe('invalid')
        expect(result.error?.message).toContain('reminder.<12 hex>, trigger.<12 hex>, or a schedule slug')
      }
    }
    expect(readFileSync(calls, 'utf8')).toBe('')
    // The shapes the API issues still pass; a legacy runtime id is a runtime trigger, never a kortix.yaml slug (no --apply).
    expect((await run('kortix_schedules', { action: 'remove', id: 'reminder.aaaaaaaaaaaa' })).ok).toBe(true)
    expect((await run('kortix_schedules', { action: 'run_now', id: 'automation.bbbbbbbbbbbb' })).ok).toBe(true)
    expect((await run('kortix_schedules', { action: 'remove', id: 'automation.bbbbbbbbbbbb' })).ok).toBe(true)
    expect(argvs()).toEqual(['loops rm reminder.aaaaaaaaaaaa', 'triggers run automation.bbbbbbbbbbbb', 'triggers rm automation.bbbbbbbbbbbb'])
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

describe('kortix_schedules follow-through', () => {
  const TEXT = 'Check replies to the quotes sent 2026-10-31 to 12 printers; stop on 2026-11-14.'
  const LOOP = (id: string, extra: string) => `{"id":"${id}","session_id":"ses_1","source_type":"schedule","name":null,"prompt":"${TEXT}",${extra},"timezone":"UTC","state":"active","next_fire_at":"2026-10-31T15:00:00.000Z","last_fired_at":null,"last_status":null,"last_error":null,"created_by":"u_me","created_at":null}`

  test('follow_up: one `kortix loop` with the schedule as --flag=value; the card says when and the next check', async () => {
    fakeKortix(`'loop ${TEXT} --in=3h --json') echo '${LOOP('reminder.aaaaaaaaaaaa', '"every":null,"every_seconds":null,"cron":null,"at":null')}' ;;
  'loop ${TEXT} --cron=0 9 * * 1-5 --timezone=Europe/Berlin --json') echo '${LOOP('reminder.bbbbbbbbbbbb', '"every":null,"every_seconds":null,"cron":"0 9 * * 1-5","at":null')}' ;;`)
    const once = await run('kortix_schedules', { action: 'follow_up', text: TEXT, in: '3h' })
    expect(once.ok).toBe(true)
    expect(once.card.title).toBe('Follow-up set: in 3h')
    expect(once.card.rows).toEqual([{ title: 'Next check', detail: '2026-10-31 15:00 UTC' }])
    expect(once.data).toEqual({ id: 'reminder.aaaaaaaaaaaa', schedule: 'in 3h', next_fire: '2026-10-31T15:00:00.000Z', text: TEXT })
    const weekdays = await run('kortix_schedules', { action: 'follow_up', text: TEXT, cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' })
    expect(weekdays.card.title).toBe('Follow-up set: cron 0 9 * * 1-5 (Europe/Berlin)')
    expect(argvs()).toEqual([`loop ${TEXT} --in=3h --json`, `loop ${TEXT} --cron=0 9 * * 1-5 --timezone=Europe/Berlin --json`])
  })

  test('follow_up and wake_on refuse a missing text, a missing schedule, and option-shaped values, before any command runs (CWE-88)', async () => {
    fakeKortix('')
    const refused = [
      { action: 'follow_up', in: '3h' },
      { action: 'follow_up', text: TEXT },
      { action: 'follow_up', text: '--help', in: '3h' },
      { action: 'follow_up', text: TEXT, cron: '0 9 * * *', timezone: '--project' },
      { action: 'wake_on', text: TEXT },
      { action: 'wake_on', text: TEXT, on: 'cr_merged' },
      { action: 'wake_on', text: TEXT, on: 'cr_merged', cr: '--all' },
      { action: 'wake_on', text: TEXT, on: 'webhook', secret_env: 'A B' },
      { action: 'wake_on', text: TEXT, on: 'connector_event', connector: '-x', event: 'NEW_MAIL' },
      { action: 'wake_on', text: TEXT, on: 'connector_event', connector: 'gmail', event: 'NEW_MAIL', config: ['x'] },
      { action: 'wake_on', text: TEXT, on: 'app_event', app: 'shop', event: '--json' },
      { action: 'wake_on', text: '-x', on: 'app_event', app: 'shop' },
      { action: 'events', connector: '--apps' },
      { action: 'remove', id: '--all' },
    ]
    for (const args of refused) {
      const result = await run('kortix_schedules', args)
      expect({ args, kind: result.error?.kind, message: result.error?.message }).toMatchObject({ args, kind: "invalid" })
    }
    expect(readFileSync(calls, 'utf8')).toBe('')
  })

  test('follow_up without text: refused once, then set with a generic text named by the call\'s label; a call with text resets it', async () => {
    fakeKortix(`'loop '*' --in=4d --json') echo '${LOOP('reminder.dddddddddddd', '"every":null,"every_seconds":null,"cron":null,"at":null')}' ;;`)
    // The call a dev session repeated 3 times: no `text`, an invented `id`.
    const call = { action: 'follow_up', in: '4d', id: 'bakery-quotes-check' }
    const first = await run('kortix_schedules', call)
    expect(first.error?.kind).toBe('invalid')
    expect(readFileSync(calls, 'utf8')).toBe('')
    const second = await run('kortix_schedules', call)
    expect(second.ok).toBe(true)
    const data = second.data as { text: string; fallback_text: boolean; text_note: string }
    expect(data.fallback_text).toBe(true)
    expect(data.text).toStartWith('Follow-up "bakery-quotes-check" set ')
    expect(data.text_note).toContain('do not remove it, replace it or set it again')
    expect(argvs()).toEqual([`loop ${data.text} --in=4d --json`])
    // A call with text in between: the next missing text is refused again.
    expect((await run('kortix_schedules', { action: 'follow_up', in: '4d', text: TEXT })).ok).toBe(true)
    expect((await run('kortix_schedules', { action: 'follow_up', in: '4d' })).ok).toBe(false)
  })

  test('follow_up tolerates the call a model makes: an alias for text, an unknown id, and both at and in (at wins, and the result says so)', async () => {
    fakeKortix(`'loop ${TEXT} --at=2026-11-04T08:00:00Z --json') echo '${LOOP('reminder.eeeeeeeeeeee', '"every":null,"every_seconds":null,"cron":null,"at":"2026-11-04T08:00:00Z"')}' ;;
  'loop ${TEXT} --in=4d --json') echo '${LOOP('reminder.ffffffffffff', '"every":null,"every_seconds":null,"cron":null,"at":null')}' ;;
  'triggers add ${TEXT} --on=cr-merged --cr=42 --json') echo '{"id":"trigger.cccccccccccc","source":{"type":"change_request","cr_id":"42"},"next_fire_at":null}' ;;`)
    // The call a live session made, with a text alias added: no `text`, both `at` and `in`, an invented `id`.
    const both = await run('kortix_schedules', { at: '2026-11-04T08:00:00Z', id: 'sticker-quote-check', in: '4d', action: 'follow_up', prompt: TEXT })
    expect(both.ok).toBe(true)
    expect(both.card.title).toBe('Follow-up set: at 2026-11-04 08:00 UTC')
    expect(both.data).toMatchObject({ id: 'reminder.eeeeeeeeeeee', used: 'at', ignored: ['in'] })
    expect((both.data as { note: string }).note).toContain('ignored `in`')
    for (const alias of ['message', 'note']) {
      expect((await run('kortix_schedules', { action: 'follow_up', in: '4d', [alias]: TEXT })).ok).toBe(true)
    }
    // One schedule field: no note.
    const single = await run('kortix_schedules', { action: 'follow_up', in: '4d', note: TEXT })
    expect(single.data).not.toHaveProperty('note')
    expect((await run('kortix_schedules', { action: 'wake_on', on: 'cr_merged', cr: '42', message: TEXT, id: 'x' })).ok).toBe(true)
    expect(argvs()).toEqual([
      `loop ${TEXT} --at=2026-11-04T08:00:00Z --json`,
      `loop ${TEXT} --in=4d --json`,
      `loop ${TEXT} --in=4d --json`,
      `loop ${TEXT} --in=4d --json`,
      `triggers add ${TEXT} --on=cr-merged --cr=42 --json`,
    ])
  })

  test('follow_up precedence is at > in > cron > every; a truly missing text says what to pass, with a one-line example', async () => {
    fakeKortix(`'loop ${TEXT} --in=3h --json') echo '${LOOP('reminder.aaaaaaaaaaaa', '"every":null,"every_seconds":null,"cron":null,"at":null')}' ;;
  'loop ${TEXT} --cron=0 9 * * 1-5 --json') echo '${LOOP('reminder.bbbbbbbbbbbb', '"every":null,"every_seconds":null,"cron":"0 9 * * 1-5","at":null')}' ;;`)
    expect((await run('kortix_schedules', { action: 'follow_up', text: TEXT, every: '4h', in: '3h', cron: '0 9 * * 1-5' })).data).toMatchObject({ used: 'in', ignored: ['cron', 'every'] })
    expect((await run('kortix_schedules', { action: 'follow_up', text: TEXT, every: '4h', cron: '0 9 * * 1-5' })).data).toMatchObject({ used: 'cron', ignored: ['every'] })
    const missing = await run('kortix_schedules', { at: '2026-11-04T08:00:00Z', id: 'sticker-quote-check', in: '4d', action: 'follow_up' })
    expect(missing.error?.kind).toBe('invalid')
    expect(missing.error?.message).toStartWith('Missing `text`')
    // The example is a whole call the model can copy.
    const example = missing.error!.message.slice(missing.error!.message.indexOf('{'))
    expect(JSON.parse(example)).toMatchObject({ action: 'follow_up', in: '4d' })
    expect((await run('kortix_schedules', { action: 'wake_on', on: 'cr_merged', cr: '42' })).error?.message).toContain('{"action":"wake_on"')
    expect(argvs()).toHaveLength(2)
  })

  test('wake_on: each `on` is one `kortix triggers add … --on=…`; a webhook returns the URL the outside system calls', async () => {
    const trigger = (source: string) => `{"id":"trigger.cccccccccccc","origin":"runtime","name":null,"prompt":"x","agent":"meta","state":"active","source":${source},"target":{"kind":"session","session_id":"ses_1","session_name":null},"next_fire_at":null,"last_fired_at":null,"last_status":null,"last_error":null}`
    fakeKortix(`'triggers add ${TEXT} --on=cr-merged --cr=42 --json') echo '${trigger('{"type":"change_request","cr_id":"42","base":null}')}' ;;
  'triggers add ${TEXT} --on=webhook --secret-env=ORDERS_SECRET --json') echo '${trigger('{"type":"webhook","secret_env":"ORDERS_SECRET","webhook_url":"https://api.example.com/v1/webhooks/proj_1/trigger.cccccccccccc"}')}' ;;
  'triggers add ${TEXT} --on=event --connector=gmail --event=GMAIL_NEW_GMAIL_MESSAGE --config={"labelIds":"INBOX"} --json') echo '${trigger('{"type":"event","connector":"gmail","event":"GMAIL_NEW_GMAIL_MESSAGE"}')}' ;;
  'triggers add ${TEXT}'*' --on=app --app=shop --json') echo '${trigger('{"type":"app","app":"shop"}')}' ;;`)
    const merged = await run('kortix_schedules', { action: 'wake_on', text: TEXT, on: 'cr_merged', cr: '42' })
    expect(merged.card.title).toBe('Will wake when change request 42 merges')
    expect(merged.data).toMatchObject({ id: 'trigger.cccccccccccc', on: 'cr_merged', condition: 'change request 42 merges', next_fire: null })
    const hook = await run('kortix_schedules', { action: 'wake_on', text: TEXT, on: 'webhook', secret_env: 'ORDERS_SECRET' })
    expect(hook.card.title).toBe('Will wake when the webhook is called')
    expect(hook.card.rows).toEqual([{ title: 'Webhook URL', detail: 'https://api.example.com/v1/webhooks/proj_1/trigger.cccccccccccc' }])
    expect(hook.data).toMatchObject({ webhook_url: 'https://api.example.com/v1/webhooks/proj_1/trigger.cccccccccccc' })
    const mail = await run('kortix_schedules', { action: 'wake_on', text: TEXT, on: 'connector_event', connector: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE', config: { labelIds: 'INBOX' } })
    expect(mail.card.title).toBe('Will wake when gmail sends GMAIL_NEW_GMAIL_MESSAGE')
    // `--on app` has no event filter: the text tells the woken turn which event matters.
    const app = await run('kortix_schedules', { action: 'wake_on', text: TEXT, on: 'app_event', app: 'shop', event: 'order.paid' })
    expect(app.card.title).toBe('Will wake when App shop sends order.paid')
    expect(argvs()[3]).toBe(`triggers add ${TEXT} (This wakes on every event from App shop; act only on "order.paid" and end the turn on any other.) --on=app --app=shop --json`)
    expect(argvs()).toHaveLength(4)
  })

  test('events: the event types a connector can wake a session with, one row each, with their config fields in data', async () => {
    fakeKortix(`'triggers events --connector=gmail --json') echo '{"source":"composio","provider":"composio","app":"gmail","event_types":[{"type":"GMAIL_NEW_GMAIL_MESSAGE","name":"New email","description":"Fires when a new email arrives in the inbox.","app":"gmail","delivery":"poll","config_schema":{"properties":{"labelIds":{"type":"string","description":"Label to watch"}},"required":["labelIds"]},"payload_schema":null}]}' ;;`)
    const result = await run('kortix_schedules', { action: 'events', connector: 'gmail' })
    expect(result.card.title).toBe('1 event on gmail')
    expect(result.card.rows).toEqual([{ title: 'GMAIL_NEW_GMAIL_MESSAGE', detail: 'Fires when a new email arrives in the inbox.' }])
    expect(result.data).toEqual({ connector: 'gmail', events: [{ type: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New email', description: 'Fires when a new email arrives in the inbox.', config: [{ name: 'labelIds', required: true, description: 'Label to watch' }] }] })
  })

  test("list: this session's follow-ups and wake-ons, then the project schedules, each with id, plain schedule or condition and next fire", async () => {
    fakeKortix(`'triggers ls --json') echo '{"triggers":[{"slug":"weekly-digest","name":"Weekly digest","prompt_template":"Summarize","enabled":true,"cron":"0 9 * * 1","next_fire_at":"2026-11-02T09:00:00.000Z"}],"runtime":[{"id":"reminder.aaaaaaaaaaaa","origin":"runtime","prompt":"${TEXT}","state":"active","source":{"type":"schedule","every":"3h"},"target":{"kind":"session","session_id":"ses_1"},"next_fire_at":"2026-10-31T15:00:00.000Z"},{"id":"trigger.cccccccccccc","origin":"runtime","prompt":"Verify prod","state":"active","source":{"type":"change_request","cr_id":"42","base":null},"target":{"kind":"session","session_id":"ses_1"},"next_fire_at":null},{"id":"reminder.dddddddddddd","origin":"runtime","prompt":"Another session","state":"active","source":{"type":"schedule","every":"1h"},"target":{"kind":"session","session_id":"ses_9"},"next_fire_at":null}]}' ;;
  'loops ls --json') echo '{"reminders":[${LOOP('reminder.aaaaaaaaaaaa', '"every":"3h","every_seconds":10800,"cron":null,"at":null')},{"id":"trigger.cccccccccccc","session_id":"ses_1","source_type":"change_request","name":null,"prompt":"Verify prod","every":null,"cron":null,"timezone":"UTC","at":null,"state":"active","next_fire_at":null}]}' ;;`)
    const result = await run('kortix_schedules', { action: 'list' })
    expect(result.card.title).toBe('1 follow-up, 1 wake-on, 1 schedule')
    expect(result.data).toEqual({
      follow_ups: [{ id: 'reminder.aaaaaaaaaaaa', text: TEXT, schedule: 'every 3h', next_fire: '2026-10-31T15:00:00.000Z', state: 'active' }],
      wake_ons: [{ id: 'trigger.cccccccccccc', text: 'Verify prod', condition: 'change request 42 merges', next_fire: null, state: 'active' }],
      schedules: [{ id: 'weekly-digest', text: 'Weekly digest', schedule: '0 9 * * 1', agent: null, next_fire: '2026-11-02T09:00:00.000Z', state: 'active' }],
    })
    expect(result.card.rows?.map((row) => row.detail)).toEqual(['Follow-up · every 3h · next 2026-10-31 15:00 UTC', 'Wakes when change request 42 merges', '0 9 * * 1 · next 2026-11-02 09:00 UTC'])
  })

  test('remove routes by id: reminder.<id> → kortix loops, trigger.<id> → kortix triggers, a kortix.yaml slug → --apply; delete is an alias; pause and resume work for loops', async () => {
    fakeKortix(`'loops rm reminder.aaaaaaaaaaaa') echo 'Removed' ;;
  'triggers rm trigger.cccccccccccc') echo 'Removed' ;;
  'triggers rm weekly-digest --apply') echo 'Removed' ;;
  'loops pause reminder.aaaaaaaaaaaa') echo 'Paused' ;;
  'loops resume reminder.aaaaaaaaaaaa') echo 'Resumed' ;;
  'loops run reminder.aaaaaaaaaaaa') echo 'Sent' ;;`)
    expect((await run('kortix_schedules', { action: 'remove', id: 'reminder.aaaaaaaaaaaa' })).card.title).toBe('Removed')
    const alias = await run('kortix_schedules', { action: 'delete', id: 'trigger.cccccccccccc' })
    expect(alias.action).toBe('delete')
    expect(alias.ok).toBe(true)
    await run('kortix_schedules', { action: 'remove', id: 'weekly-digest' })
    await run('kortix_schedules', { action: 'pause', id: 'reminder.aaaaaaaaaaaa' })
    await run('kortix_schedules', { action: 'resume', id: 'reminder.aaaaaaaaaaaa' })
    await run('kortix_schedules', { action: 'run_now', id: 'reminder.aaaaaaaaaaaa' })
    expect(argvs()).toEqual([
      'loops rm reminder.aaaaaaaaaaaa',
      'triggers rm trigger.cccccccccccc',
      'triggers rm weekly-digest --apply',
      'loops pause reminder.aaaaaaaaaaaa',
      'loops resume reminder.aaaaaaaaaaaa',
      'loops run reminder.aaaaaaaaaaaa',
    ])
  })

  test('Loops turned off: the refusal says so in plain words and where to turn them on', async () => {
    fakeKortix(`'loop ${TEXT} --every=4h --json') echo '✗ Loops is not enabled for this project. Enable it in Settings → Feature flags.' >&2; echo '  Turn it on: kortix projects features enable reminders' >&2; exit 1 ;;`)
    const result = await run('kortix_schedules', { action: 'follow_up', text: TEXT, every: '4h' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('Loops is not enabled for this project. Enable it in Settings → Feature flags. Ask the person or a project admin to turn it on.')
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

describe('kortix_change_requests', () => {
  const CR = `{"cr_id":"cr-uuid-3","number":3,"title":"Upgrade the manifest","description":"Moves kortix.yaml to the current format.","status":"open","base_ref":"refs/heads/main","head_ref":"refs/heads/kortix/session-a","origin_session_id":"ses_9","created_by":"u_sam","created_at":"2026-10-30T09:00:00.000Z"}`
  const SHOW = `'cr show 3 --json') echo '{"change_request":${CR},"merge_preview":{"can_merge":true,"can_fast_forward":true,"conflicts":[],"is_up_to_date":false}}' ;;`

  test('list: the open change requests with number, title, author and status, each linked to Review', async () => {
    fakeKortix(`'cr ls --status=open --json') echo '{"change_requests":[${CR}]}' ;;
  ${ROSTER}`)
    const result = await run('kortix_change_requests', { action: 'list' })
    expect(result.ok).toBe(true)
    expect(result.card.title).toBe('1 open change request')
    expect(result.card.rows).toEqual([{ title: '#3 Upgrade the manifest', detail: 'Sam', badge: 'open', href: '/projects/proj_1/review?id=cr%3Acr-uuid-3' }])
    expect(result.data).toEqual({
      change_requests: [{ number: 3, cr_id: 'cr-uuid-3', title: 'Upgrade the manifest', author: 'Sam', status: 'open', from: 'kortix/session-a', into: 'main', session_id: 'ses_9', opened_at: '2026-10-30T09:00:00.000Z' }],
    })
  })

  test('get: the summary, how many files it changes and whether it can merge', async () => {
    fakeKortix(`${SHOW}
  'cr diff 3 --json') printf '%s\n' '{"cr":${CR},"patch":"diff --git a/kortix.yaml b/kortix.yaml\\n--- a/kortix.yaml\\n+++ b/kortix.yaml\\n-old: 1\\n+new: 1\\n+more: 2\\ndiff --git a/README.md b/README.md\\n+line\\n"}' ;;
  ${ROSTER}`)
    const result = await run('kortix_change_requests', { action: 'get', id: '#3' })
    expect(result.card.title).toBe('#3 Upgrade the manifest')
    expect(result.card.subtitle).toBe('Moves kortix.yaml to the current format.')
    expect(result.card.rows).toEqual([
      { title: '2 files changed', detail: '+3 −1' },
      { title: 'Ready to merge, no conflicts.', badge: 'ready' },
      { title: 'Opened by Sam' },
      { title: 'Status', badge: 'open' },
    ])
    expect(result.data).toMatchObject({ number: 3, files_changed: 2, additions: 3, deletions: 1, can_merge: true, conflicts: [] })
    expect(result.card.links).toContainEqual({ label: 'Session that made it', href: '/projects/proj_1/sessions/ses_9' })
  })

  test('merge: an open one merges with its message as --message=<text>; a closed one is refused before any merge', async () => {
    fakeKortix(`${SHOW}
  'cr merge 3 --message=- tidy up') echo 'Merged CR #3 (fast-forward) abc1234'; echo 'Also merged #4, #5: their commits landed with it.' ;;
  'cr show 4 --json') echo '{"change_request":{"cr_id":"cr-uuid-4","number":4,"title":"Old","status":"closed"},"merge_preview":null}' ;;`)
    const merged = await run('kortix_change_requests', { action: 'merge', id: '3', message: '- tidy up' })
    expect(merged.ok).toBe(true)
    expect(merged.card.title).toBe('Merged #3 Upgrade the manifest')
    expect(merged.card.subtitle).toBe('#4, #5 merged with it: their changes were part of it.')
    expect(merged.data).toMatchObject({ number: 3, status: 'merged', also_merged: ['#4', '#5'] })
    const refused = await run('kortix_change_requests', { action: 'merge', id: '4' })
    expect(refused.error).toEqual({ kind: 'invalid', message: 'Change request #4 is closed: only an open one merges.' })
    expect(argvs()).toEqual(['cr show 3 --json', 'cr merge 3 --message=- tidy up', 'cr show 4 --json'])
  })

  test('close: closes an open one; a refusal names who can grant it', async () => {
    fakeKortix(`${SHOW}
  'cr close 3') echo '{"kortix_error":{"kind":"denied","status":403,"action":"project.review.act"}}' >&2; exit 1 ;;
  ${ROSTER}`)
    const result = await run('kortix_change_requests', { action: 'close', id: '3' })
    expect(result.ok).toBe(false)
    expect(result.card.status).toBe('denied')
    expect(result.error?.message).toContain('project.review.act')
    expect(result.card.subtitle).toBe('Sam, ada@example.com can grant it.')
  })

  test('an option-shaped or missing id never reaches the CLI (CWE-88)', async () => {
    fakeKortix(`'cr merge') echo 'merged something' ;;`)
    for (const id of ['--project', '-h', '#-1', 'a b', '']) {
      for (const action of ['get', 'merge', 'close']) {
        expect((await run('kortix_change_requests', { action, id })).error?.kind).toBe('invalid')
      }
    }
    expect(readFileSync(calls, 'utf8')).toBe('')
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

describe('kortix_schedules automations', () => {
  test('automate: a connector event becomes one live kortix.yaml trigger with its filter, one session per thread, a cap and a model, each as --flag=value', async () => {
    fakeKortix(`'triggers add issue-triage '*' --apply') printf 'Added issue-triage (live)\\n' ;;`)
    const result = await run('kortix_schedules', {
      action: 'automate',
      name: 'issue-triage',
      on: 'connector_event',
      connector: 'github',
      event: 'GITHUB_ISSUE_OPENED',
      config: { repo: 'acme/site' },
      agent: 'triage',
      prompt: 'If this is not a real bug report, stop: do nothing and send no message. Otherwise label {{ event.data.title }}.',
      filter: { 'event.data.action': ['opened', 'reopened'], 'event.data.sender': { not: 'kortix-bot' }, 'event.data.draft': { exists: false } },
      session_key: '{{ event.data.number }}',
      max_runs_per_day: 20,
      model: 'kortix/deepseek-v4.1-flash',
    })
    expect(result.ok).toBe(true)
    expect(result.card.title).toBe('Automation set: issue-triage')
    expect(result.card.subtitle).toBe('triage runs on GITHUB_ISSUE_OPENED on github, one session per key')
    expect(argvs()).toEqual([
      'triggers add issue-triage --type=event --prompt=If this is not a real bug report, stop: do nothing and send no message. Otherwise label {{ event.data.title }}. ' +
        '--agent=triage --connector=github --event=GITHUB_ISSUE_OPENED --model=kortix/deepseek-v4.1-flash --config-json={"repo":"acme/site"} ' +
        '--filter=event.data.action:in=opened,reopened --filter=event.data.sender:not=kortix-bot --filter=event.data.draft:exists=false ' +
        '--session-key={{ event.data.number }} --max-runs-per-day=20 --apply',
    ])
  })

  test('automate: a webhook returns the URL the outside system calls, and a schedule takes every', async () => {
    fakeKortix(`'triggers add form-leads '*' --apply') printf 'Added form-leads (live)\\n  webhook https://api.example.test/v1/webhooks/proj_1/form-leads\\n' ;;
  'triggers add weekly-digest '*' --apply') printf 'Added weekly-digest (live)\\n' ;;`)
    const hook = await run('kortix_schedules', { action: 'automate', name: 'form-leads', on: 'webhook', secret_env: 'FORM_SECRET', agent: 'sales', prompt: 'Draft a reply to {{ body.email }}.', session_key: '{{ body.email }}' })
    expect(hook.ok).toBe(true)
    expect((hook.data as { webhook_url: string }).webhook_url).toBe('https://api.example.test/v1/webhooks/proj_1/form-leads')
    expect(hook.card.rows).toContainEqual({ title: 'Webhook URL', detail: 'https://api.example.test/v1/webhooks/proj_1/form-leads' })
    const weekly = await run('kortix_schedules', { action: 'automate', name: 'weekly-digest', on: 'schedule', every: '1d', agent: 'writer', prompt: 'Write the digest.' })
    expect(weekly.ok).toBe(true)
    expect(argvs()[1]).toBe('triggers add weekly-digest --type=cron --prompt=Write the digest. --agent=writer --every=1d --apply')
  })

  test('automate refuses a bad name, source, filter, option-shaped value, missing source field or cap before any command runs (CWE-88)', async () => {
    fakeKortix('')
    const base = { action: 'automate', name: 'x', on: 'webhook', secret_env: 'S', prompt: 'Go.' }
    const refused = [
      { ...base, name: '../etc' },
      { ...base, name: 'Has Caps' },
      { ...base, on: 'cr_merged' },
      { ...base, prompt: '--apply' },
      { ...base, secret_env: undefined },
      { ...base, secret_env: '--project=other' },
      { ...base, agent: '--all' },
      { ...base, filter: ['body.action'] },
      { ...base, filter: { 'body action': 'x' } },
      { ...base, filter: { 'body.action': { equals: 'x' } } },
      { ...base, filter: { 'body.action': ['a,b'] } },
      { ...base, session_key: '-x' },
      { ...base, max_runs_per_day: 0 },
      { ...base, on: 'connector_event', connector: 'gmail' },
      { ...base, on: 'schedule' },
    ]
    for (const args of refused) {
      const result = await run('kortix_schedules', args)
      expect({ args, ok: result.ok, kind: result.error?.kind }).toMatchObject({ args, ok: false, kind: 'invalid' })
    }
    expect(readFileSync(calls, 'utf8')).toBe('')
  })

  test('test: a dry run reports the filter verdict, the session key and the rendered prompt, and fires nothing', async () => {
    fakeKortix(`'triggers fire issue-triage --dry-run --payload={"event":{"data":{"number":7}}} --json') echo '{"filter_matches":true,"session_key":"7","rendered_prompt":"Label Login fails","payload":{}}' ;;
  'triggers fire issue-triage --dry-run --json') echo '{"filter_matches":false,"session_key":null,"rendered_prompt":"Label ","payload":{}}' ;;`)
    const hit = await run('kortix_schedules', { action: 'test', name: 'issue-triage', payload: { event: { data: { number: 7 } } } })
    expect(hit.ok).toBe(true)
    expect(hit.card.title).toBe('issue-triage would run')
    expect(hit.data).toEqual({ name: 'issue-triage', filter_matches: true, session_key: '7', prompt: 'Label Login fails' })
    const miss = await run('kortix_schedules', { action: 'test', id: 'issue-triage' })
    expect(miss.card.title).toBe('issue-triage would skip this event')
    expect((await run('kortix_schedules', { action: 'test', name: 'x', payload: 'nope' })).ok).toBe(false)
  })

  test('runs: the recent runs with a tally of what started, skipped and failed, and no cost', async () => {
    fakeKortix(`'triggers runs issue-triage --limit=20 --json') echo '{"runs":[{"status":"fired","run_status":"succeeded","error":null,"session_id":"s1","started_at":"2026-11-01T09:00:00Z","cost_usd":0.3},{"status":"skipped","run_status":null,"error":"filter did not match","session_id":null,"started_at":"2026-11-01T08:00:00Z","cost_usd":null}],"next_cursor":null}' ;;`)
    const result = await run('kortix_schedules', { action: 'runs', name: 'issue-triage' })
    expect(result.ok).toBe(true)
    expect(result.card.subtitle).toBe('1 fired · 1 skipped')
    expect(JSON.stringify(result)).not.toContain('cost')
    expect((result.data as { tally: Record<string, number> }).tally).toEqual({ fired: 1, skipped: 1 })
  })
})

describe('kortix_schedules automate tolerance', () => {
  test('a missing `on` is read from the fields the call gave: secret_env is a webhook, connector + event a connector event, app an App event, cron or every a schedule', async () => {
    fakeKortix(`'triggers add '*' --apply') printf 'Added (live)\\n' ;;`)
    const calls_ = [
      { args: { secret_env: 'S' }, type: 'webhook' },
      { args: { connector: 'gmail', event: 'GMAIL_NEW_MESSAGE' }, type: 'event' },
      { args: { app: 'watcher' }, type: 'app' },
      { args: { every: '1d' }, type: 'cron' },
    ]
    for (const [i, c] of calls_.entries()) {
      const result = await run('kortix_schedules', { action: 'automate', name: `a${i}`, prompt: 'Go.', ...c.args })
      expect({ i, ok: result.ok }).toEqual({ i, ok: true })
      expect(argvs()[i]).toContain(`--type=${c.type}`)
    }
    // Nothing to read it from: still refused, before any command.
    expect((await run('kortix_schedules', { action: 'automate', name: 'a9', prompt: 'Go.' })).error?.kind).toBe('invalid')
    expect(argvs()).toHaveLength(4)
  })

  test('a webhook secret that is missing or stored for agents: the result carries a link where the person saves it for webhooks', async () => {
    fakeKortix(`'triggers add form-leads '*' --apply') echo '{"kortix_error":{"kind":"invalid","status":422,"message":"Webhook secret is not configured for webhooks (webhook_secret_delivery_mismatch)"}}' >&2; exit 1 ;;
  'secrets request FORM_SECRET --scope=connector') printf '\\n  Hand this link to whoever has the value (FORM_SECRET)\\n  https://app.example.test/secret-intake/ksl_abc123\\n' ;;`)
    const result = await run('kortix_schedules', { action: 'automate', name: 'form-leads', on: 'webhook', secret_env: 'FORM_SECRET', prompt: 'Draft a reply.' })
    expect(result.ok).toBe(false)
    expect(result.card.title).toBe('FORM_SECRET needs saving for webhooks')
    expect(result.error?.message).toContain('https://app.example.test/secret-intake/ksl_abc123')
    expect((result as { data?: { secret_intake_url?: string } }).data?.secret_intake_url).toBe('https://app.example.test/secret-intake/ksl_abc123')
    expect(argvs()[1]).toBe('secrets request FORM_SECRET --scope=connector')
  })
})
