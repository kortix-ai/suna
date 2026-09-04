/**
 * Projection builders — the contract `/kortix/opencode/*` serves.
 *
 * Fixtures mirror OpenCode 1.18.23's real payloads: `/agent` entries carrying a
 * 10-20 KB system prompt, `/command` entries carrying the whole template,
 * `/config` carrying the 2.6 MB provider catalog, and transcript parts carrying
 * base64 `data:` attachments. Each test asserts BOTH halves of the contract:
 * the field survives, and the weight does not.
 */
import { describe, expect, test } from 'bun:test'

import {
  TOOL_METADATA_MAX_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  canonicalJson,
  etagOf,
  projectAgents,
  projectCommands,
  projectConfig,
  projectMessageInfo,
  projectPart,
  projectPermissions,
  projectQuestions,
  projectSessionRows,
  projectSessions,
  projectStatuses,
  projectTranscript,
} from '../opencode-projection'

const bigPrompt = 'You are a careful engineer. '.repeat(600) // ~16 KB

describe('projectAgents', () => {
  test('keeps the composer fields and drops the system prompt', () => {
    const raw = [
      {
        name: 'essentia-agi',
        description: 'The single Essentia working agent',
        mode: 'primary',
        native: false,
        hidden: null,
        color: null,
        permission: { edit: 'allow' },
        prompt: bigPrompt,
        options: {},
        model: { providerID: 'kortix', modelID: 'gpt-5.6-sol' },
      },
      { name: 'build', description: 'builtin', mode: 'primary', native: true, permission: {}, options: {} },
    ]
    const projected = projectAgents(raw)
    expect(projected).toHaveLength(2)
    expect(projected[0]).toMatchObject({
      name: 'essentia-agi',
      description: 'The single Essentia working agent',
      mode: 'primary',
      native: false,
      source: 'config',
      model: { providerID: 'kortix', modelID: 'gpt-5.6-sol' },
    })
    expect(projected[1]!.source).toBe('builtin')
    const json = JSON.stringify(projected)
    expect(json).not.toContain('careful engineer')
    // The whole projected roster is smaller than ONE raw agent's prompt.
    expect(json.length).toBeLessThan(bigPrompt.length)
  })

  test('accepts the name-keyed object form OpenCode also answers with', () => {
    const projected = projectAgents({ build: { name: 'build', mode: 'primary', native: true } })
    expect(projected.map((a) => a.name)).toEqual(['build'])
  })

  test('drops an entry with no name rather than inventing one', () => {
    expect(projectAgents([{ description: 'nameless' }, null, 7])).toEqual([])
  })
})

describe('projectCommands', () => {
  test('replaces the template with its byte count', () => {
    const template = '# Init\n'.repeat(200)
    const projected = projectCommands([
      { name: 'init', description: 'guided AGENTS.md setup', hints: ['$ARGUMENTS'], template },
    ])
    expect(projected[0]).toEqual({
      name: 'init',
      description: 'guided AGENTS.md setup',
      agent: null,
      model: null,
      source: null,
      subtask: null,
      hints: ['$ARGUMENTS'],
      template_bytes: template.length,
    })
    expect(JSON.stringify(projected)).not.toContain('# Init')
  })
})

describe('projectConfig', () => {
  test('keeps model + permission defaults and reduces the provider catalog to names', () => {
    const provider = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`p${i}`, { models: Object.fromEntries(Array.from({ length: 200 }, (_, j) => [`m${j}`, { name: 'x'.repeat(200) }])) }]),
    )
    const raw = {
      model: 'kortix/codex/gpt-5.6-sol',
      small_model: 'kortix/codex/gpt-5.6-sol',
      agent: 'essentia-agi',
      permission: { edit: 'allow' },
      instructions: ['AGENTS.md'],
      provider,
    }
    const rawBytes = JSON.stringify(raw).length
    const projected = projectConfig(raw)
    expect(projected).toEqual({
      model: 'kortix/codex/gpt-5.6-sol',
      small_model: 'kortix/codex/gpt-5.6-sol',
      default_agent: 'essentia-agi',
      permission: { edit: 'allow' },
      instructions: ['AGENTS.md'],
      enabled_providers: Object.keys(provider),
    })
    // The live measurement was 11,889x. The fixture is smaller; assert the
    // shape of the win, not a number the fixture cannot support.
    expect(JSON.stringify(projected).length).toBeLessThan(rawBytes / 100)
  })

  test('an unexpected payload yields nulls, never a throw', () => {
    expect(projectConfig(null).model).toBeNull()
    expect(projectConfig('nope').enabled_providers).toBeNull()
  })
})

describe('session, status, permission and question projections', () => {
  test('session list from OpenCode HTTP', () => {
    const projected = projectSessions([
      { id: 'ses_a', title: 'New session', directory: '/workspace', time: { created: 1, updated: 9 } },
    ])
    expect(projected[0]).toMatchObject({ id: 'ses_a', title: 'New session', time: { created: 1, updated: 9, compacting: null } })
  })

  test('session list from opencode.db rows produces the identical shape', () => {
    const fromRows = projectSessionRows([
      {
        id: 'ses_a',
        title: 'New session',
        directory: '/workspace',
        parent_id: null,
        time_created: 1,
        time_updated: 9,
        time_compacting: null,
        revert: null,
      },
    ])
    const fromHttp = projectSessions([
      { id: 'ses_a', title: 'New session', directory: '/workspace', time: { created: 1, updated: 9 } },
    ])
    // Same fact, two sources: the wire shape MUST NOT depend on which one
    // answered, or a fallback becomes a visible behaviour change.
    expect(fromRows).toEqual(fromHttp)
  })

  test('statuses keep only the type', () => {
    expect(projectStatuses({ ses_a: { type: 'busy', attempt: 3, message: 'retrying' } })).toEqual({
      ses_a: { type: 'busy' },
    })
  })

  test('permissions and questions keep the ids a reply needs and nothing else', () => {
    expect(
      projectPermissions([
        { id: 'per_1', sessionID: 'ses_a', permission: 'bash', patterns: ['rm *'], metadata: { huge: 'x'.repeat(5000) }, always: [] },
      ]),
    ).toEqual([{ id: 'per_1', sessionID: 'ses_a', permission: 'bash', patterns: ['rm *'], tool: null }])
    expect(
      projectQuestions([{ id: 'qst_1', sessionID: 'ses_a', questions: [{ question: 'x'.repeat(4000) }] }]),
    ).toEqual([{ id: 'qst_1', sessionID: 'ses_a' }])
  })
})

describe('message and part projection', () => {
  test('message info keeps what the transcript renders', () => {
    const info = {
      id: 'msg_1',
      sessionID: 'ses_a',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      agent: 'build',
      modelID: 'gpt',
      providerID: 'kortix',
      cost: 0.01,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: '/workspace', root: '/workspace' },
      system: 'x'.repeat(9000),
    }
    const projected = projectMessageInfo(info)
    expect(projected.id).toBe('msg_1')
    expect(projected.tokens).toEqual(info.tokens)
    expect(projected.system).toBeUndefined()
    expect(projected.path).toBeUndefined()
  })

  test('oversized tool metadata is replaced by its size', () => {
    const part = {
      id: 'prt_1',
      messageID: 'msg_1',
      sessionID: 'ses_a',
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: {
        status: 'completed',
        title: 'ls',
        input: { command: 'ls' },
        output: 'a\nb\n',
        time: { start: 1, end: 2 },
        metadata: { dom: 'x'.repeat(TOOL_METADATA_MAX_BYTES + 1) },
      },
    }
    const projected = projectPart(part) as { state: Record<string, unknown> }
    expect(projected.state.metadata).toBeUndefined()
    expect(projected.state.metadata_bytes).toBeGreaterThan(TOOL_METADATA_MAX_BYTES)
    expect(projected.state.output).toBe('a\nb\n')
  })

  test('small tool metadata survives untouched', () => {
    const projected = projectPart({
      id: 'prt_1',
      messageID: 'msg_1',
      type: 'tool',
      state: { status: 'completed', metadata: { rows: 3 } },
    }) as { state: Record<string, unknown> }
    expect(projected.state.metadata).toEqual({ rows: 3 })
  })

  test('ids are verbatim — never renamed, never synthesised', () => {
    const projected = projectPart({ id: 'prt_ZZZ', messageID: 'msg_ZZZ', sessionID: 'ses_ZZZ', type: 'text', text: 'hi' })
    expect(projected).toMatchObject({ id: 'prt_ZZZ', messageID: 'msg_ZZZ', sessionID: 'ses_ZZZ' })
  })
})

describe('projectTranscript', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(200_000)}`

  test('attachment bytes become /kortix/part refs and never travel', () => {
    const result = projectTranscript(
      [
        {
          info: { id: 'msg_1', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } },
          parts: [
            { id: 'prt_file', messageID: 'msg_1', sessionID: 'ses_a', type: 'file', mime: 'image/png', url: dataUrl },
            { id: 'prt_text', messageID: 'msg_1', sessionID: 'ses_a', type: 'text', text: 'done' },
          ],
        },
      ],
      'ses_a',
    )
    const json = JSON.stringify(result.messages)
    expect(json).not.toContain('AAAA')
    expect(json).toContain('/kortix/part/ses_a/msg_1/prt_file')
    expect(result.stripped).toBe(1)
    expect(result.savedBytes).toBeGreaterThan(199_000)
  })

  test('a tool screenshot inside state.attachments is referenced too', () => {
    const result = projectTranscript(
      [
        {
          info: { id: 'msg_2', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } },
          parts: [
            {
              id: 'prt_tool',
              messageID: 'msg_2',
              sessionID: 'ses_a',
              type: 'tool',
              tool: 'browser',
              state: {
                status: 'completed',
                attachments: [{ id: 'att_1', type: 'file', mime: 'image/png', url: dataUrl }],
              },
            },
          ],
        },
      ],
      'ses_a',
    )
    expect(JSON.stringify(result.messages)).toContain('/kortix/part/ses_a/msg_2/att_1')
    expect(JSON.stringify(result.messages)).not.toContain('AAAA')
  })

  test('a giant tool output is truncated with an explicit marker', () => {
    const output = 'L'.repeat(TOOL_OUTPUT_MAX_BYTES + 5_000)
    const result = projectTranscript(
      [
        {
          info: { id: 'msg_3', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } },
          parts: [{ id: 'prt_1', messageID: 'msg_3', sessionID: 'ses_a', type: 'tool', state: { status: 'completed', output } }],
        },
      ],
      'ses_a',
    )
    const state = (result.messages[0]!.parts[0] as { state: Record<string, unknown> }).state
    expect(state.output_truncated).toBe(true)
    expect(String(state.output)).toContain('truncated 5000 bytes')
    expect(result.truncated).toBe(1)
  })
})

describe('etag', () => {
  test('canonical JSON sorts keys at every depth so key order cannot bust a cache', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(etagOf({ b: 1, a: 2 })).toBe(etagOf({ a: 2, b: 1 }))
  })

  test('array order IS significant — a reordered transcript is a different etag', () => {
    expect(etagOf([1, 2])).not.toBe(etagOf([2, 1]))
  })

  test('a changed value changes the etag', () => {
    expect(etagOf({ model: 'a' })).not.toBe(etagOf({ model: 'b' }))
  })
})
