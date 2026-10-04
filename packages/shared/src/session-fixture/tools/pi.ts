/**
 * The file and question tools as the pi harness sends them, for the session
 * parity fixture.
 *
 * pi uses OpenCode's tool names with its own shapes (pi-agent-core harness
 * tools, `apps/kortix-sandbox-agent-server/src/harness/pi/tools.ts`):
 * - `read`/`write`/`edit` name the file `path`, not `filePath`;
 * - `edit` takes `edits: [{ oldText, newText }]` and returns
 *   `details: { diff, patch, firstChangedLine }` — `patch` is a unified diff,
 *   `diff` is pi's own numbered format;
 * - `question` returns `details: { answers }`.
 * A tool's `details` is the part's `state.metadata`. Renderers read these
 * through the SDK's `inputPath` and `toToolView`, so the rows must name the
 * file, draw the patch, and show the answers exactly as they do for OpenCode.
 */

import type { FixtureToolGroup } from '../types';

const FORMAT_BEFORE = 'export function formatCurrency(value: number): string {\n  return `$${value.toFixed(2)}`;\n}\n';
const PATCH = [
  '--- src/lib/format.ts',
  '+++ src/lib/format.ts',
  '@@ -1,3 +1,5 @@',
  ' export function formatCurrency(value: number): string {',
  '-  return `$${value.toFixed(2)}`;',
  "+  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(value);",
  '+  // Compact: $1.2K, $3.4M.',
  ' }',
  '',
].join('\n');

export const PI_TOOL_GROUP: FixtureToolGroup = {
  key: 'pi',
  prompt: 'On the pi runtime: switch formatCurrency to compact notation and write down why.',
  reasoning: 'I will read the helper, ask which notation the card should use, edit it, and record the decision in `docs/currency.md`.',
  summary: '`formatCurrency` now uses compact USD notation, as chosen. The decision is in `docs/currency.md`.',
  specs: [
    {
      renderer: 'read-tool.tsx',
      tool: 'read',
      input: { path: 'src/lib/format.ts' },
      output: FORMAT_BEFORE,
      error: 'Could not read file: src/lib/format.ts. Error code: ENOENT.',
      states: ['completed', 'error'],
      note: 'pi names the file `path`; the row takes it through the SDK `inputPath`.',
    },
    {
      renderer: 'question-tool.tsx',
      tool: 'question',
      input: {
        questions: [
          {
            question: 'Which notation should the revenue card use?',
            header: 'Notation',
            options: [
              { label: 'Compact', description: '$1.2K, $3.4M' },
              { label: 'Full', description: '$1,234.00' },
            ],
          },
        ],
      },
      output: 'User answered:\nNotation: Compact',
      metadata: { answers: [['Compact']] },
      error: 'The user dismissed the question.',
      states: ['completed'],
      note: 'pi returns the answers as `details.answers` (the part metadata), as OpenCode does.',
    },
    {
      renderer: 'edit-tool.tsx',
      tool: 'edit',
      input: {
        path: 'src/lib/format.ts',
        edits: [
          {
            oldText: '  return `$${value.toFixed(2)}`;',
            newText:
              "  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(value);\n  // Compact: $1.2K, $3.4M.",
          },
        ],
      },
      output: 'Successfully replaced 1 block(s) in src/lib/format.ts.',
      metadata: {
        diff: ' 1 export function formatCurrency(value: number): string {\n-2   return `$${value.toFixed(2)}`;\n+2   return new Intl.NumberFormat(…).format(value);\n+3   // Compact: $1.2K, $3.4M.\n 4 }',
        patch: PATCH,
        firstChangedLine: 2,
      },
      error: 'Could not edit file: src/lib/format.ts. Error code: ENOENT.',
      states: ['completed', 'error'],
      note: 'No before/after: the row draws the unified `patch` and counts +2 −1 from it (SDK `ToolFile`).',
    },
    {
      renderer: 'write-tool.tsx',
      tool: 'write',
      input: {
        path: 'docs/currency.md',
        content: '# Currency\n\nThe revenue card uses compact USD notation (`$1.2K`), chosen on 2026-09-16.\n',
      },
      output: 'Successfully wrote to docs/currency.md',
      error: 'Could not write file: docs/currency.md. Error code: EACCES.',
      states: ['completed'],
      note: 'pi names the file `path`.',
    },
  ],
};
