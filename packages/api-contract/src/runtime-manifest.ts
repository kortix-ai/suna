export interface RuntimeManifestSignature {
  algorithm: 'ed25519'
  key_id: string
  value: string
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  throw new Error('Runtime manifest contains a non-JSON value')
}

/** Stable bytes signed by the API and verified before any node mutation. */
export function runtimeManifestSigningPayload(manifest: Record<string, unknown>): string {
  const { signature: _signature, ...unsigned } = manifest
  return canonical(unsigned)
}
