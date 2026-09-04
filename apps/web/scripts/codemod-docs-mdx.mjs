// One-shot codemod for the fumadocs to Blume migration. Kept in the repo (not
// run in CI) so the conversion is reviewable and repeatable, and so the
// fence-safety rule below has a test that pins it.

const CALLOUT_TYPE_TO_DIRECTIVE = {
  warn: 'warning',
  warning: 'warning',
  info: 'info',
  error: 'danger',
};

// Sentinel a transform emits in place of a deleted line; collapseDropped()
// filters it out. Exported so Tasks 6 and 7 reference the constant rather
// than re-typing the literal, which would silently stop being filtered if
// the two ever drift apart.
export const DROP_MARKER = '__DROP_LINE__';

// Walk lines, tracking whether we are inside a fenced code block. Every
// transform in this module is a no-op while inside one: docs pages carry
// example source with real `import` lines, and rewriting those would corrupt
// the examples.
export function mapOutsideFences(source, mapLine) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : mapLine(line));
  }
  return out.join('\n');
}

// A dropped import leaves the blank line that followed it. Remove both, then
// squeeze any run of three or more newlines the removals opened up.
export function collapseDropped(source) {
  return source
    .split('\n')
    .filter((line) => line !== DROP_MARKER)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

export function convertCallouts(source) {
  let openDepth = 0;
  const mapped = mapOutsideFences(source, (line) => {
    const drop =
      /^import\s*\{[^}]*\bCallout\b[^}]*\}\s*from\s*'fumadocs-ui\/components\/callout';\s*$/;
    if (drop.test(line)) return DROP_MARKER;

    const open = line.match(
      /^\s*<Callout(?:\s+type="([a-z]+)")?(?:\s+title="([^"]*)")?\s*>\s*$/,
    );
    if (open) {
      openDepth += 1;
      const kind = CALLOUT_TYPE_TO_DIRECTIVE[open[1] ?? ''] ?? 'note';
      return open[2] ? `:::${kind}[${open[2]}]` : `:::${kind}`;
    }
    if (/^\s*<\/Callout>\s*$/.test(line) && openDepth > 0) {
      openDepth -= 1;
      return ':::';
    }
    return line;
  });

  return collapseDropped(mapped);
}
