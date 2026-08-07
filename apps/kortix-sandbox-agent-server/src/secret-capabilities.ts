import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SECRET_CAPABILITIES_ENV_NAME = 'KORTIX_SECRET_CAPABILITIES'
export const SECRET_CAPABILITIES_INSTRUCTION_PATH = '/tmp/kortix/secret-capabilities.md'

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
const SERVICE_CONSUMERS = new Set(['llm_gateway', 'connector', 'git_proxy'])
const MAX_CATALOG_BYTES = 64 * 1024

type CatalogEntry = {
  identifier: string
  delivery: 'sandbox' | 'https_broker' | 'kortix_service'
  environment_variable?: string
  consumer?: string
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
      if (!['sandbox', 'https_broker', 'kortix_service'].includes(String(item.delivery))) return []
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
        },
      ]
    })
  } catch {
    return []
  }
}

export function renderSecretCapabilitiesInstruction(raw: string | undefined): string {
  const entries = parseCatalog(raw)
  const lines = [
    '# Session secret capabilities',
    '',
    'Kortix grants this session only the secret capabilities listed below.',
    `Read \`$${SECRET_CAPABILITIES_ENV_NAME}\` for machine-readable usage rules.`,
    'Never print, copy, or return a secret value or broker handle.',
    'Use sandbox secrets through their named environment variable.',
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
      } else {
        lines.push(
          `- \`${entry.identifier}\`: Kortix service \`${entry.consumer ?? 'managed'}\`; no sandbox plaintext.`,
        )
      }
    }
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
