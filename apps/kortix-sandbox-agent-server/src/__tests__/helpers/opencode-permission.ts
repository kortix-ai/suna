import { wildcardMatch } from '@/harness/pi/interactions'

/**
 * OpenCode 1.18.23's own evaluation (permission/index.ts `fromConfig`,
 * `merge`, `evaluate`): each block flattens to (permission, pattern, action)
 * rules in key order, blocks concatenate, and the LAST matching rule wins.
 * Undefined when no rule matches (OpenCode then asks).
 */
export function openCodeAction(blocks: unknown[], permission: string, subject: string): string | undefined {
  const rules = blocks.flatMap((block) => {
    const map = typeof block === 'string' ? { '*': block } : ((block ?? {}) as Record<string, unknown>)
    return Object.entries(map).flatMap(([key, rule]) =>
      typeof rule === 'string'
        ? [{ key, pattern: '*', action: rule }]
        : Object.entries(rule as Record<string, string>).map(([pattern, action]) => ({ key, pattern, action })),
    )
  })
  return rules.findLast((rule) => wildcardMatch(permission, rule.key) && wildcardMatch(subject, rule.pattern))?.action
}
