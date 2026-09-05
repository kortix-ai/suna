import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The session's subproject, rendered for the agent (spec §7).
 *
 * apps/api hands the manifest's `subprojects.<slug>` block down as
 * KORTIX_SUBPROJECT_CONTEXT (see apps/api/src/projects/lib/subproject-envelope.ts);
 * the daemon writes it as an OpenCode `instructions` file, exactly like the
 * secret-capability guide next door. Nothing here parses a manifest and nothing
 * here is a permission — the API already decided this session belongs to this
 * subproject.
 */

export const SUBPROJECT_ENV_NAME = 'KORTIX_SUBPROJECT'
export const SUBPROJECT_CONTEXT_ENV_NAME = 'KORTIX_SUBPROJECT_CONTEXT'
export const SUBPROJECT_INSTRUCTION_PATH = '/tmp/kortix/subproject.md'

/** The API caps the envelope at 64 KB; refuse anything larger outright. */
const MAX_ENVELOPE_BYTES = 64 * 1024

type Envelope = {
  slug: string
  name: string
  description: string | null
  instructions: string | null
  context: string[]
}

function parseEnvelope(raw: string | undefined): Envelope | null {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.version !== 1) return null
    if (typeof value.slug !== 'string' || !value.slug) return null
    const str = (key: string) =>
      typeof value[key] === 'string' && (value[key] as string).trim() ? (value[key] as string) : null
    return {
      slug: value.slug,
      name: str('name') ?? value.slug,
      description: str('description'),
      instructions: str('instructions'),
      context: Array.isArray(value.context)
        ? value.context.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
        : [],
    }
  } catch {
    return null
  }
}

/** The markdown OpenCode inlines into every turn. `''` when no valid envelope. */
export function renderSubprojectInstruction(raw: string | undefined): string {
  const envelope = parseEnvelope(raw)
  if (!envelope) return ''
  const lines = [`# Subproject: ${envelope.name}`, '']
  if (envelope.description) lines.push(envelope.description, '')
  if (envelope.instructions) {
    lines.push('## Instructions', '', envelope.instructions.trim(), '')
  }
  if (envelope.context.length > 0) {
    lines.push('## Context', '', 'Read these before answering:')
    for (const entry of envelope.context) lines.push(`- \`${entry}\``)
    lines.push('')
  }
  lines.push(
    'Sessions you start with `kortix sessions new` inherit this subproject unless you pass `--subproject`.',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Write the rendered instruction atomically and return its path, or `null` when
 * this session has no subproject (nothing is written, no stale file is left
 * behind from a previous tenant of the box).
 */
export function writeSubprojectInstruction(
  env: NodeJS.ProcessEnv,
  path = SUBPROJECT_INSTRUCTION_PATH,
): string | null {
  const content = renderSubprojectInstruction(env[SUBPROJECT_CONTEXT_ENV_NAME])
  if (!content) return null
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return path
}
