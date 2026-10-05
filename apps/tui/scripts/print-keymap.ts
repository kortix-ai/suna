/**
 * Print the whole keymap as the Markdown table `README.md` carries.
 *
 *   bun run apps/tui/scripts/print-keymap.ts
 *   pnpm --filter @kortix/tui keymap
 *
 * The README's key table is generated, never hand-written: a hand-written one
 * drifts the first time a feature adds a binding, and a key table that lies is
 * worse than none. Re-run this and paste the output whenever `allBindings()`
 * changes.
 */

import { helpLines } from '../src/features/help/help-overlay.tsx';
import { SCOPE_TITLE, allBindings, formatBinding } from '../src/keymap.ts';

function escapePipes(text: string): string {
  return text.replaceAll('|', '\\|');
}

const lines = helpLines(allBindings());
const out: string[] = [];

for (const line of lines) {
  if (line.kind === 'section') {
    out.push(
      '',
      `### ${SCOPE_TITLE[line.scope] ?? line.scope}`,
      '',
      '| Keys | Action |',
      '| --- | --- |',
    );
    continue;
  }
  const keys = formatBinding(line.binding) || 'any other key';
  out.push(`| \`${escapePipes(keys)}\` | ${escapePipes(line.binding.description)} |`);
}

out.push('', `_${lines.filter((line) => line.kind === 'binding').length} bindings._`);
process.stdout.write(`${out.join('\n').trim()}\n`);
