import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { createAbortRouter } from '../routes/abort'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import type { QuickQueueArm } from '../quick-queue-interrupt'

const secret = 'local-test-secret'
const body = Buffer.from(JSON.stringify({
  userId: 'user-1', sandboxId: 'sandbox-1', sandboxRole: 'owner', scopes: ['*'],
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
})).toString('base64url')
const signed = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`

describe('abort after tool', () => {
  test('requires a signed context and arms only the named prompt', async () => {
    const armed: QuickQueueArm[] = []
    const disarmed: Array<string | undefined> = []
    const controller = {
      arm: async (input: QuickQueueArm) => { armed.push(input) },
      disarm: (promptId?: string) => { disarmed.push(promptId) },
    }
    const router = createAbortRouter(
      { sandboxToken: secret } as Config,
      {} as Opencode,
      controller,
    )
    const payload = {
      prompt_id: 'prompt-1', opencode_session_id: 'ses_root', turn_message_id: 'msg_running',
    }
    const unauthorized = await router.request('/after-tool', {
      method: 'POST', body: JSON.stringify(payload),
    })
    expect(unauthorized.status).toBe(401)
    expect(armed).toEqual([])

    const accepted = await router.request('/after-tool', {
      method: 'POST',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(accepted.status).toBe(202)
    expect(armed).toEqual([{
      promptId: 'prompt-1', opencodeSessionId: 'ses_root', messageId: 'msg_running',
    }])

    const removed = await router.request('/after-tool', {
      method: 'DELETE',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: 'prompt-1' }),
    })
    expect(removed.status).toBe(200)
    expect(disarmed).toEqual(['prompt-1'])

    const held = await router.request('/after-tool', {
      method: 'DELETE',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    expect(held.status).toBe(200)
    expect(disarmed).toEqual(['prompt-1', undefined])
  })
})
