import { describe, expect, test } from 'bun:test'

import { createInitialOpenCodeSession, deliverInitialOpenCodePrompt, resumeInitialOpenCodeSession } from '../main'
import {
  resumeCanonicalAcpSession,
  type Opencode,
} from '../opencode'

function acpRuntime() {
  const calls: Array<{ method: string; params: unknown; id?: string | number }> = []
  const connection = {
    ready: true,
    async request(method: string, params: unknown, id?: string | number) {
      calls.push({ method, params, id })
      if (method === 'session/new') return { sessionId: 'ses_acp' }
      return {}
    },
    async post(envelope: { id?: string | number; method?: string; params?: unknown }) {
      calls.push({
        method: envelope.method ?? 'response',
        params: envelope.params,
        id: envelope.id,
      })
    },
  }
  const opencode = {
    getTransport: () => 'acp',
    getAcpConnection: () => connection,
    getInternalUrl: () => 'http://127.0.0.1:4096',
  } as unknown as Opencode
  return { opencode, calls }
}

describe('ACP initial session boot', () => {
  test('creates and resumes the canonical session through ACP', async () => {
    const runtime = acpRuntime()

    await expect(createInitialOpenCodeSession(runtime.opencode, '/workspace')).resolves.toEqual({
      id: 'ses_acp',
    })
    await resumeInitialOpenCodeSession(runtime.opencode, 'ses_acp', '/workspace')

    expect(runtime.calls.slice(0, 2)).toEqual([
      {
        method: 'session/new',
        params: { cwd: '/workspace', mcpServers: [] },
        id: undefined,
      },
      {
        method: 'session/resume',
        params: {
          sessionId: 'ses_acp',
          cwd: '/workspace',
          mcpServers: [],
        },
        id: undefined,
      },
    ])
  })

  test('delivers the initial prompt through ACP without waiting for turn completion', async () => {
    const runtime = acpRuntime()

    await deliverInitialOpenCodePrompt(runtime.opencode, 'ses_acp', '/workspace', {
      parts: [{ type: 'text', text: 'Run.' }],
      model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' },
      agent: 'reviewer',
    })

    expect(runtime.calls.map((call) => call.method)).toEqual([
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ])
    expect(runtime.calls[0]?.params).toEqual({
      sessionId: 'ses_acp',
      configId: 'model',
      value: 'kortix/anthropic/claude-sonnet-4-6',
    })
    expect(runtime.calls[1]?.params).toEqual({
      sessionId: 'ses_acp',
      configId: 'mode',
      value: 'reviewer',
    })
    expect(runtime.calls[2]?.params).toEqual({
      sessionId: 'ses_acp',
      prompt: [{ type: 'text', text: 'Run.' }],
    })
  })

  test('resumes the canonical session after the ACP process restarts', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const connection = {
      async request(method: string, params: unknown) {
        calls.push({ method, params })
        return {}
      },
    }

    await resumeCanonicalAcpSession(connection, 'ses_acp', '/workspace')

    expect(calls).toEqual([
      {
        method: 'session/resume',
        params: {
          sessionId: 'ses_acp',
          cwd: '/workspace',
          mcpServers: [],
        },
      },
    ])
  })
})
