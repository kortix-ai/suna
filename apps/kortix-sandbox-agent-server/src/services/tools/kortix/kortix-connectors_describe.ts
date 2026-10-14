interface ToolContext {
  env: Record<string, string | undefined>
  signal: AbortSignal
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default {
  description: 'Show a connector tool input schema, risk, description and accounts. Pass a connector-namespaced tool path, for example synthetic.items.read.',
  parameters: {
    type: 'object',
    properties: { tool: { type: 'string', description: 'Connector-namespaced tool path: <connector>.<action>.' } },
    required: ['tool'],
    additionalProperties: false,
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    if (typeof args.tool !== 'string' || !args.tool.trim()) throw new Error('tool must be a non-empty string.')
    const tool = args.tool.trim()
    const separator = tool.indexOf('.')
    if (separator <= 0 || separator === tool.length - 1) throw new Error('tool must be a "<connector>.<action>" path.')
    const connector = tool.slice(0, separator)
    const action = tool.slice(separator + 1)
    const query = new URLSearchParams({ slug: connector, include_schemas: 'true' })
    const api = context.env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
    const token = context.env.KORTIX_TOKEN?.trim()
    if (!api) throw new Error('KORTIX_API_URL is not set.')
    if (!token) throw new Error('KORTIX_TOKEN is not set.')
    const response = await fetch(`${api.endsWith('/v1') ? api : `${api}/v1`}/connectors/catalog?${query}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
      redirect: 'error',
    })
    const catalog: unknown = await response.json()
    // Preserve authorization/error envelopes instead of disguising them as a missing action.
    if (!object(catalog) || !Array.isArray(catalog.connectors)) return catalog
    for (const entry of catalog.connectors) {
      if (!object(entry) || entry.slug !== connector || !Array.isArray(entry.actions)) continue
      const found: unknown = entry.actions.find((candidate: unknown) => object(candidate) && candidate.path === action)
      if (object(found)) return {
        tool,
        risk: found.risk,
        description: found.description,
        inputSchema: found.inputSchema,
        accounts: entry.accounts ?? [],
        default_account: entry.default_account ?? null,
      }
    }
    throw new Error(`Action ${tool} not found in the session catalog.`)
  },
}
