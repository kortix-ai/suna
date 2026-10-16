interface ToolContext {
  env: Record<string, string | undefined>
  signal: AbortSignal
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default {
  description: 'Run a connector action through the session gateway. The gateway enforces access, account selection and approval policy. Return denials or pending approvals to the user; never bypass them or retry writes.',
  parameters: {
    type: 'object',
    properties: {
      connector: { type: 'string', description: 'Connector slug from the session catalog.' },
      action: { type: 'string', description: 'Action path within the connector.' },
      args: { type: 'object', description: 'Arguments matching the action input schema.' },
      account: { type: 'string', description: 'Optional connected account label or id. Omit to use the gateway default.' },
      approval_context: { type: 'string', description: 'Plain-language explanation shown to a human if approval is required.' },
    },
    required: ['connector', 'action'],
    additionalProperties: false,
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    if (typeof args.connector !== 'string' || !args.connector.trim()) throw new Error('connector must be a non-empty string.')
    if (typeof args.action !== 'string' || !args.action.trim()) throw new Error('action must be a non-empty string.')
    const connector = args.connector.trim()
    const action = args.action.trim()
    if (args.args !== undefined && !object(args.args)) throw new Error('args must be an object.')
    if (args.account !== undefined && (typeof args.account !== 'string' || !args.account.trim())) throw new Error('account must be a non-empty string.')
    if (args.approval_context !== undefined && (typeof args.approval_context !== 'string' || !args.approval_context.trim())) throw new Error('approval_context must be a non-empty string.')
    const account = args.account?.trim()
    const approvalContext = args.approval_context?.trim()
    const api = context.env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
    const token = context.env.KORTIX_TOKEN?.trim()
    if (!api) throw new Error('KORTIX_API_URL is not set.')
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    const response = await fetch(`${api.endsWith('/v1') ? api : `${api}/v1`}/connectors/call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connector, action, args: args.args ?? {}, ...(account ? { account } : {}), ...(approvalContext ? { approval_context: approvalContext } : {}) }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
      redirect: 'error',
    })
    // Gateway denials and pending approvals are outcomes, not transport errors.
    // Never retry a POST: it can have executed even if its response was lost.
    const result: unknown = await response.json()
    return result
  },
}

