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
    {
      renderer: 'codemode-tool.tsx',
      tool: 'codemode',
      input: {
        code: "const usages = await tools.grep({ pattern: 'formatCurrency', path: 'src' });\nconst checked = await tools.bash({ command: 'bun test src/lib/format.test.ts' });\nreturn [usages, checked];",
      },
      output: 'Script completed\nWall time 1.2 seconds\nOutput:\n==> text 1/2 <==\nsrc/lib/format.ts:1\nsrc/components/RevenueCard.tsx:4\n==> text 2/2 <==\n3 pass, 0 fail',
      metadata: {
        calls: [
          { call_id: 'call_codemode/1', name: 'grep', kind: 'grep', input: { pattern: 'formatCurrency', path: 'src' }, status: 'complete', duration_ms: 40 },
          { call_id: 'call_codemode/2', name: 'bash', kind: 'shell', input: { command: 'bun test src/lib/format.test.ts' }, status: 'complete', duration_ms: 1100 },
        ],
        complete: true,
      },
      runningMetadata: {
        calls: [
          { id: 'call_codemode/1', name: 'grep', args: '{"pattern":"formatCurrency","path":"src"}', status: 'ok', durationMs: 40 },
          { id: 'call_codemode/2', name: 'bash', args: '{"command":"bun test src/lib/format.test.ts"}', status: 'running' },
        ],
      },
      error:
        'Script failed\nWall time 0.1 seconds\nOutput:\nScript error:\nError: The project policy denies this bash call.\n\nTool calls made before the failure (they are not undone): grep (ok), bash (error)',
      note: "pi's codemode: one script that calls other tools. Running, the calls come from pi's live record (`id`, `args` as JSON text); at rest, from the session log's record (`call_id`, `input`, `complete`). The result drops pi's `Script completed` / `Wall time` / `Output:` header. A denied nested call throws inside the script, so `error` ends with `Error: <reason>` and the live-status call summary.",
    },
  ],
};
