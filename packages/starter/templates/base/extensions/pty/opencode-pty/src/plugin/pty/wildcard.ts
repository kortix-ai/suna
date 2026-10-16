export function match(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    's'
  )
  return regex.test(str)
}

export function all(input: string, patterns: Record<string, string>): string | undefined {
  const sorted = Object.entries(patterns).sort(
    (a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0])
  )
  let result: string | undefined
  for (const [pattern, value] of sorted) {
    if (match(input, pattern)) {
      result = value
    }
  }
  return result
}

export function allStructured(
  input: { head: string; tail: string[] },
  patterns: Record<string, string>
): string | undefined {
  const sorted = Object.entries(patterns).sort(
    (a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0])
  )
  let result: string | undefined
  for (const [pattern, value] of sorted) {
    const parts = pattern.split(/\s+/)
    const firstPart = parts[0]
    if (!firstPart || !match(input.head, firstPart)) continue
    if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) {
      result = value
    }
  }
  return result
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return true
  const [pattern, ...rest] = patterns
  if (pattern === '*') return matchSequence(items, rest)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (
      item !== undefined &&
      pattern !== undefined &&
      match(item, pattern) &&
      matchSequence(items.slice(i + 1), rest)
    ) {
      return true
    }
  }
  return false
}
