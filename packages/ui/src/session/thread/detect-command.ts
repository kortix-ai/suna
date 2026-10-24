import type { Command } from '@kortix/sdk/react';

/** Folds every run of blank lines to one. */
const foldBlankLines = (text: string) => text.replace(/\n{3,}/g, '\n\n');

/**
 * Detect if user message text matches a known command template.
 * Returns the command name + extracted args, or undefined if no match.
 * Works by splitting each command template at its first placeholder
 * ($1 or $ARGUMENTS) and checking if the message text starts with that prefix.
 *
 * Extracted into its own (React-free) module so it can be unit-tested directly.
 */
/**
 * pi's `/skill` message: `<skill name="…" location="…">\n<SKILL.md>\n</skill>`, then
 * `\n\n<args>` (`commandPrompt` in kortixd's pi runtime). pi lists a skill with an
 * empty template, so only this envelope names it after a reload. A SKILL.md can
 * hold its own `</skill>`, so the envelope closes at the last one.
 */
export function detectSkillEnvelope(rawText: string): { name: string; args?: string; source: 'skill' } | undefined {
  const text = rawText.trim();
  const open = /^<skill name="([^"]+)" location="[^"]*">\n/.exec(text);
  if (!open) return undefined;
  const close = text.lastIndexOf('\n</skill>');
  if (close < open[0].length - 1) return undefined;
  const args = text.slice(close + '\n</skill>'.length).trim();
  return { name: open[1], args: args || undefined, source: 'skill' };
}

export function detectCommandFromText(
  rawText: string,
  commands?: Command[],
): { name: string; args?: string; source?: 'skill' } | undefined {
  const skill = rawText ? detectSkillEnvelope(rawText) : undefined;
  if (skill) return skill;
  // `commands` is typed `Command[]`, but the runtime's `GET /command` has been
  // observed answering with a truthy NON-array (Better Stack, dev 2026-08-23:
  // "TypeError: t is not iterable" thrown from the `for…of` below, which took
  // the whole session view down through the error boundary). `@kortix/sdk` now
  // normalizes that response, and this guard keeps the crash site itself safe
  // for any other caller — same spirit as the non-string `template` guard below.
  if (!Array.isArray(commands) || !rawText) return undefined;

  const trimmedRawText = rawText.trim();
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const cmd of commands) {
    // The opencode API (and MCP/skill-sourced commands) can return a `template`
    // that is not a string (e.g. an object/number). The SDK types it as string,
    // but the runtime value sometimes disagrees — calling `.trim()` on it throws
    // `TypeError: e.template.trim is not a function` (Sentry: template.trim).
    // Skip any command whose template isn't a usable string so detection degrades
    // gracefully instead of crashing the render. Empty/whitespace-only templates
    // are skipped later by the `prefix.length < 20` guard, matching prior behavior.
    if (typeof cmd.template !== 'string') continue;
    const tpl = cmd.template.trim();

    // For large templates (e.g. onboarding.md), skip regex entirely and do a
    // fast exact-match: strip the trailing $ARGUMENTS placeholder and check
    // if rawText matches the body. This handles commands whose template is the
    // full file content (which opencode sends verbatim as the user message).
    if (tpl.length > 2000) {
      // Strip trailing $ARGUMENTS (with optional surrounding whitespace/newlines).
      // Blank-line runs fold to one on both sides: the bubble's text went through
      // `stripSystemPtyText`, which folds them, and a SKILL.md body has them.
      // No leading `\s*`: `.trimEnd()` drops it, and `\s*\$` backtracks
      // quadratically on a long space run (CodeQL js/polynomial-redos).
      const tplBody = foldBlankLines(tpl.replace(/\$ARGUMENTS\s*$/, '').trimEnd());
      const text = foldBlankLines(trimmedRawText);
      // Fast check: does rawText equal the template body exactly?
      if (tplBody.length > 0 && text === tplBody) {
        return { name: cmd.name, args: undefined };
      }
      // Also handle the case where $ARGUMENTS is at the end and the user
      // provided some text after the template body. The prefix match is exact,
      // so the rest is the user's whole prompt, however long.
      if (tplBody.length > 0 && text.startsWith(tplBody)) {
        const after = text.slice(tplBody.length).trim();
        return { name: cmd.name, args: after.length > 0 ? after : undefined };
      }
      continue;
    }

    // Find the first placeholder position ($1, $2, ..., $ARGUMENTS)
    const placeholderMatch = tpl.match(/\$(\d+|\bARGUMENTS\b)/);
    // Use the text before the first placeholder as the prefix to match
    const prefix = placeholderMatch
      ? tpl.slice(0, placeholderMatch.index).trimEnd()
      : tpl.trimEnd();

    // Require a meaningful prefix (at least 20 chars) to avoid false positives
    if (prefix.length < 20) continue;

    if (trimmedRawText.startsWith(prefix)) {
      // Extract the user's arguments: text after the template prefix (approximate)
      // For templates ending with the placeholder, the args are what comes after the prefix
      let args: string | undefined;
      if (placeholderMatch) {
        const afterPrefix = trimmedRawText.slice(prefix.length).trim();
        // The args are at the end; try to extract the last meaningful section
        const lastNewlineBlock = afterPrefix.split('\n\n').pop()?.trim();
        if (lastNewlineBlock && lastNewlineBlock.length < 200) {
          args = lastNewlineBlock;
        }
      }
      return { name: cmd.name, args };
    }

    // Fallback: robust full-template match where placeholders are wildcards.
    // This handles commands whose template begins with a placeholder.
    const placeholderRegex = /\$(\d+|\bARGUMENTS\b)/g;
    const placeholderOrder: string[] = [];
    let regexSource = '^';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(tpl)) !== null) {
      regexSource += escapeRegExp(tpl.slice(lastIndex, match.index));
      regexSource += '([\\s\\S]*?)';
      placeholderOrder.push(match[1]);
      lastIndex = match.index + match[0].length;
    }

    regexSource += escapeRegExp(tpl.slice(lastIndex));
    regexSource += '$';

    let fullTemplateMatch: RegExpMatchArray | null;
    try {
      fullTemplateMatch = trimmedRawText.match(new RegExp(regexSource));
    } catch {
      // Regex too large or invalid — skip this command template
      continue;
    }
    if (!fullTemplateMatch) continue;

    let args: string | undefined;
    const captures = fullTemplateMatch.slice(1).map((value) => value?.trim() ?? '');
    const argumentsIndex = placeholderOrder.findIndex((name) => name.toUpperCase() === 'ARGUMENTS');
    const bestCapture =
      (argumentsIndex >= 0 ? captures[argumentsIndex] : undefined) ||
      captures.find((value) => value.length > 0);
    if (bestCapture && bestCapture.length < 200) {
      args = bestCapture;
    }

    return { name: cmd.name, args };
  }
  return undefined;
}
