/**
 * Print every slash command and the whole keymap as the Markdown tables
 * `README.md` carries.
 *
 *   bun run apps/tui/scripts/print-keymap.ts
 *   pnpm --filter @kortix/tui keymap
 *
 * The README's key table is generated, never hand-written: a hand-written one
 * drifts the first time a feature adds a binding, and a key table that lies is
 * worse than none. Re-run this and paste the output whenever `allBindings()`
 * changes.
 */

import { COMMANDS, GROUP_TITLE } from '../src/commands/registry.ts';
import { helpLines } from '../src/features/help/help-overlay.tsx';
import { allBindings, formatBinding, hintFor } from '../src/keymap.ts';

function escapePipes(text: string): string {
  return text.replaceAll('|', '\\|');
}

const lines = helpLines(allBindings());
const out: string[] = ['### Commands', '', '| Command | Also | Action |', '| --- | --- | --- |'];

for (const spec of COMMANDS) {
  const usage = 'args' in spec && spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`;
  const also = [
    ...('aliases' in spec && spec.aliases ? spec.aliases.map((alias: string) => `/${alias}`) : []),
    ...('binding' in spec && spec.binding ? [hintFor(spec.binding)] : []),
  ]
    .filter(Boolean)
    .map((word) => `\`${escapePipes(word)}\``)
    .join(' ');
  out.push(
    `| \`${escapePipes(usage)}\` | ${also} | ${GROUP_TITLE[spec.group]}: ${escapePipes(spec.description)} |`,
  );
}
out.push('', `_${COMMANDS.length} commands._`);

for (const line of lines) {
  if (line.kind === 'section') {
    out.push(
      '',
      `### ${line.title}`,
      '',
      '| Keys | Action |',
      '| --- | --- |',
    );
    continue;
  }
  if (line.kind !== 'binding') continue;
  const keys = formatBinding(line.binding) || 'any other key';
  out.push(`| \`${escapePipes(keys)}\` | ${escapePipes(line.binding.description)} |`);
}

out.push('', `_${lines.filter((line) => line.kind === 'binding').length} bindings._`);
process.stdout.write(`${out.join('\n').trim()}\n`);
