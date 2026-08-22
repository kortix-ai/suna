import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SECRET_CAPABILITIES_ENV_NAME = 'KORTIX_SECRET_CAPABILITIES'
export const SECRET_CAPABILITIES_INSTRUCTION_PATH = '/tmp/kortix/secret-capabilities.md'

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
const SERVICE_CONSUMERS = new Set(['llm_gateway', 'connector', 'git_proxy'])
const MAX_CATALOG_BYTES = 64 * 1024
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const MAX_NOTES_CHARS = 4_000

type CatalogEntry = {
  identifier: string
  delivery: 'sandbox' | 'https_broker' | 'kortix_service' | 'network'
  environment_variable?: string
  consumer?: string
  /** Egress-enforced only: the exact hosts whose requests get the real value
   *  substituted for the handle. Every other host receives the handle. */
  hosts?: string[]
}

/** The API authors the egress rules once, as `notes.network`. Rendering them
 *  here rather than restating them keeps the guest-facing wording in a single
 *  place — the agent reads this file as OpenCode `instructions`. */
function parseNetworkNotes(raw: string | undefined): string[] {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES) return []
  try {
    const value = JSON.parse(raw) as { notes?: unknown }
    const notes = value.notes as Record<string, unknown> | undefined
    const network = notes && typeof notes === 'object' ? notes.network : undefined
    // The API emits an array of rules; a plain string is accepted so a future
    // shape change degrades to "render it" instead of "drop it silently".
    const list = Array.isArray(network) ? network : typeof network === 'string' ? [network] : []
    let budget = MAX_NOTES_CHARS
    const out: string[] = []
    for (const line of list) {
      if (typeof line !== 'string' || line.length === 0) continue
      if (line.length > budget) break
      budget -= line.length
      out.push(line)
    }
    return out
  } catch {
    return []
  }
}

function parseCatalog(raw: string | undefined): CatalogEntry[] {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES) return []
  try {
    const value = JSON.parse(raw) as {
      version?: unknown
      capabilities?: unknown
    }
    if (value.version !== 1 || !Array.isArray(value.capabilities)) return []
    return value.capabilities.flatMap((entry): CatalogEntry[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const item = entry as Record<string, unknown>
      if (typeof item.identifier !== 'string' || !IDENTIFIER_RE.test(item.identifier)) return []
      if (!['sandbox', 'https_broker', 'kortix_service', 'network'].includes(String(item.delivery))) {
        return []
      }
      return [
        {
          identifier: item.identifier,
          delivery: item.delivery as CatalogEntry['delivery'],
          ...(typeof item.environment_variable === 'string' && ENV_NAME_RE.test(item.environment_variable)
            ? { environment_variable: item.environment_variable }
            : {}),
          ...(typeof item.consumer === 'string' && SERVICE_CONSUMERS.has(item.consumer)
            ? { consumer: item.consumer }
            : {}),
          ...(Array.isArray(item.hosts)
            ? {
                hosts: item.hosts.filter(
                  (host): host is string => typeof host === 'string' && HOST_RE.test(host),
                ),
              }
            : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

export function renderSecretCapabilitiesInstruction(raw: string | undefined): string {
  const entries = parseCatalog(raw)
  const hasNetwork = entries.some((entry) => entry.delivery === 'network')
  const lines = [
    '# Session secret capabilities',
    '',
    'Kortix grants this session only the secret capabilities listed below.',
    `Read \`$${SECRET_CAPABILITIES_ENV_NAME}\` for machine-readable usage rules.`,
    'Never print, copy, or return a secret value or broker handle.',
    'Use sandbox secrets through their named environment variable.',
    'Use egress-enforced secrets through their named environment variable too: it holds a handle Kortix swaps for the real value on the listed hosts.',
    'Use HTTPS broker secrets with `kortix secrets call IDENTIFIER URL [options]`.',
    'Use Kortix service secrets through the named service. They are never available as plaintext.',
    '',
  ]
  if (entries.length === 0) {
    lines.push('- No secret capabilities are granted to this session.')
  } else {
    for (const entry of entries) {
      if (entry.delivery === 'sandbox') {
        lines.push(
          `- \`${entry.identifier}\`: sandbox environment variable \`${entry.environment_variable ?? entry.identifier}\`.`,
        )
      } else if (entry.delivery === 'https_broker') {
        lines.push(
          `- \`${entry.identifier}\`: HTTPS broker. Use \`kortix secrets call ${entry.identifier} <https-url> [options]\`.`,
        )
      } else if (entry.delivery === 'network') {
        const hosts = (entry.hosts ?? []).join(', ')
        const variable = entry.environment_variable ?? entry.identifier
        lines.push(
          `- \`${entry.identifier}\`: egress-enforced. \`${variable}\` holds a Kortix handle, not the` +
            ` value. Use it exactly as you would the credential; Kortix swaps it for the real value` +
            ` outside this sandbox on your HTTPS requests to ${hosts || 'its allow-listed hosts'}.`,
        )
      } else {
        lines.push(
          `- \`${entry.identifier}\`: Kortix service \`${entry.consumer ?? 'managed'}\`; no sandbox plaintext.`,
        )
      }
    }
  }
  const networkNotes = hasNetwork ? parseNetworkNotes(raw) : []
  if (networkNotes.length > 0) {
    lines.push('', '## Egress-enforced secrets', '')
    for (const note of networkNotes) lines.push(`- ${note}`)
  }
  return `${lines.join('\n')}\n`
}

export function writeSecretCapabilitiesInstruction(
  env: NodeJS.ProcessEnv,
  path = SECRET_CAPABILITIES_INSTRUCTION_PATH,
): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, renderSecretCapabilitiesInstruction(env[SECRET_CAPABILITIES_ENV_NAME]), {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmp, path)
  return path
}
