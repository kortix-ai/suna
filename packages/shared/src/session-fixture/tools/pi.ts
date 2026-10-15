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
 * - `codemode` runs a script that calls other tools; `details.calls` lists the
 *   nested calls (live: `args` as a JSON string and `status: running`; at rest
 *   the harness `codemodeDetails` rewrite names them `call_id`/`kind` and maps
 *   the status to `complete`).
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
  summary:
    '`formatCurrency` now uses compact USD notation, as chosen. The decision is in `docs/currency.md`. A codemode script checked the typecheck and the unit tests; both pass.',
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
    {
      renderer: 'codemode-tool.tsx',
      tool: 'codemode',
      input: {
        code: [
          '// Verify the edit: typecheck and the unit tests in one script.',
          'const [typecheck, tests] = await Promise.all([',
          "  tools.bash({ command: 'bun run typecheck' }),",
          "  tools.bash({ command: 'bun test src/lib' }),",
          ']);',
          "if (!typecheck.includes('0 errors')) throw new Error('typecheck still fails');",
          'return { typecheck, tests };',
        ].join('\n'),
      },
      runningMetadata: {
        calls: [
          {
            id: 'call_FixtureParity0001/1',
            name: 'bash',
            args: '{"command":"bun run typecheck"}',
            status: 'running',
          },
          {
            id: 'call_FixtureParity0001/2',
            name: 'bash',
            args: '{"command":"bun test src/lib"}',
            status: 'running',
          },
        ],
        output: '',
      },
      metadata: {
        calls: [
          {
            call_id: 'call_FixtureParity0001/1',
            name: 'bash',
            kind: 'shell',
            status: 'complete',
            input: { command: 'bun run typecheck' },
            duration_ms: 2_130,
          },
          {
            call_id: 'call_FixtureParity0001/2',
            name: 'bash',
            kind: 'shell',
            status: 'complete',
            input: { command: 'bun test src/lib' },
            duration_ms: 970,
          },
        ],
        complete: true,
      },
      output: [
        'Script completed',
        'Wall time 3.1 seconds',
        'Output:',
        '{"typecheck":"0 errors","tests":"4 pass, 0 fail"}',
      ].join('\n'),
      error: [
        'Script failed',
        'Wall time 0.1 seconds',
        'Output:',
        'Script error:',
        'Error: typecheck still fails',
        '    at <anonymous> (codemode.js:6:48)',
        '',
        'Tool calls made before the failure (they are not undone): bash (ok), bash (ok)',
      ].join('\n'),
      durationMs: 3_150,
      note: "Live, pi sends `details.calls` with `args` as a JSON string and `status: running`; at rest the harness `codemodeDetails` writes `call_id`, `kind`, `status: complete` and `duration_ms`. The renderer strips pi's `Script completed/failed` header from `output` and `error`. Nested ids carry the codemode call id plus `/<n>`.",
    },
  ],
};
