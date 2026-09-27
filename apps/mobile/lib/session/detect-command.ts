import type { Command } from '@/lib/opencode/hooks/use-opencode-data';

// ---------------------------------------------------------------------------
// detectCommandFromText — detect if a user message matches a command template
// ---------------------------------------------------------------------------

export function detectCommandFromText(
  rawText: string,
  commands?: Command[],
): { name: string; args?: string } | undefined {
  if (!commands || !rawText) return undefined;

  const trimmed = rawText.trim();
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const cmd of commands) {
    // `template` is typed as string but can arrive non-string from MCP/skill
    // command sources; guard before `.trim()` to avoid a TypeError crash.
    // Canonical implementation: apps/web/src/features/session/detect-command.ts.
    if (typeof cmd.template !== 'string') continue;
    const tpl = cmd.template.trim();

    // Large templates — fast exact/prefix match
    if (tpl.length > 2000) {
      const tplBody = tpl.replace(/\s*\$ARGUMENTS\s*$/, '').trimEnd();
      if (tplBody.length > 0 && trimmed === tplBody) {
        return { name: cmd.name, args: undefined };
      }
      if (tplBody.length > 0 && trimmed.startsWith(tplBody)) {
        const after = trimmed.slice(tplBody.length).trim();
        return { name: cmd.name, args: after.length > 0 && after.length < 200 ? after : undefined };
      }
      continue;
    }

    // Find first placeholder ($1, $ARGUMENTS)
    const phMatch = tpl.match(/\$(\d+|\bARGUMENTS\b)/);
    const prefix = phMatch ? tpl.slice(0, phMatch.index).trimEnd() : tpl.trimEnd();

    if (prefix.length < 20) continue;

    if (trimmed.startsWith(prefix)) {
      let args: string | undefined;
      if (phMatch) {
        const afterPrefix = trimmed.slice(prefix.length).trim();
        const lastBlock = afterPrefix.split('\n\n').pop()?.trim();
        if (lastBlock && lastBlock.length < 200) args = lastBlock;
      }
      return { name: cmd.name, args };
    }

    // Fallback — full regex match with placeholder wildcards
    const phRegex = /\$(\d+|\bARGUMENTS\b)/g;
    const placeholders: string[] = [];
    let src = '^';
    let lastIdx = 0;
    let m: RegExpExecArray | null;

    while ((m = phRegex.exec(tpl)) !== null) {
      src += escapeRe(tpl.slice(lastIdx, m.index));
      src += '([\\s\\S]*?)';
      placeholders.push(m[1]);
      lastIdx = m.index + m[0].length;
    }
    src += escapeRe(tpl.slice(lastIdx)) + '$';

    let fullMatch: RegExpMatchArray | null;
    try {
      fullMatch = trimmed.match(new RegExp(src));
    } catch {
      continue;
    }
    if (!fullMatch) continue;

    const captures = fullMatch.slice(1).map((v) => v?.trim() ?? '');
    const argsIdx = placeholders.findIndex((n) => n.toUpperCase() === 'ARGUMENTS');
    const best =
      (argsIdx >= 0 ? captures[argsIdx] : undefined) ||
      captures.find((v) => v.length > 0);
    return {
      name: cmd.name,
      args: best && best.length < 200 ? best : undefined,
    };
  }
  return undefined;
}
