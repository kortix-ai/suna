/**
 * The compiled agent set (`KORTIX_COMPILED_AGENT_CONFIG`, apps/api
 * compile-agent-config.ts) of a kortix.yaml v3 project carries `schema: 3`.
 * Such a session reads its whole configuration from that set: no harness
 * config folder, no project `opencode.json(c)`, no `.opencode/`.
 *
 * Returns the parsed set when it is v3, else null (v1/v2, absent, malformed).
 */
export function compiledSetV3(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const set = JSON.parse(raw) as unknown
    return set && typeof set === 'object' && !Array.isArray(set) && (set as { schema?: unknown }).schema === 3
      ? (set as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
