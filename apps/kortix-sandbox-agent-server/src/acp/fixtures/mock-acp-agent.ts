import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
const pendingPrompts = new Map<
  string | number,
  { promptId: string | number; sessionId: unknown }
>()

lines.on('line', (line) => {
  const envelope = JSON.parse(line) as {
    id?: string | number
    method?: string
    params?: Record<string, unknown>
  }
  if (envelope.id === undefined) return

  if (!envelope.method) {
    const pending = pendingPrompts.get(envelope.id)
    if (!pending) return
    pendingPrompts.delete(envelope.id)
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: pending.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'permission response received',
            },
          },
        },
      })}\n`,
    )
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: pending.promptId,
        result: { stopReason: 'end_turn' },
      })}\n`,
    )
    return
  }

  if (envelope.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: envelope.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Mock ACP harness', version: '1.0.0' },
        },
      })}\n`,
    )
    return
  }

  if (envelope.method === 'session/prompt') {
    const prompt = Array.isArray(envelope.params?.prompt)
      ? envelope.params.prompt
      : []
    const requestPermission = prompt.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        'text' in block &&
        block.text === 'request permission',
    )
    if (requestPermission) {
      const requestId = `permission:${envelope.id}`
      pendingPrompts.set(requestId, {
        promptId: envelope.id,
        sessionId: envelope.params?.sessionId,
      })
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: 'session/request_permission',
          params: {
            sessionId: envelope.params?.sessionId,
            toolCall: {
              toolCallId: 'mock-tool',
              title: 'Run mock tool',
              kind: 'execute',
            },
            options: [
              {
                optionId: 'allow_once',
                name: 'Allow once',
                kind: 'allow_once',
              },
            ],
          },
        })}\n`,
      )
      return
    }

    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: envelope.params?.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'mock response' },
          },
        },
      })}\n`,
    )
  }

  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: envelope.id,
      result:
        envelope.method === 'session/new'
          ? { sessionId: 'mock-session' }
          : { stopReason: 'end_turn' },
    })}\n`,
  )
})
