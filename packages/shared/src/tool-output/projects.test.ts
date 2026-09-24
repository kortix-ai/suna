import { describe, expect, test } from 'bun:test';
import {
  connectorRows,
  labelValue,
  parseConnectorGetOutput,
  parseConnectorListOutput,
  parseConnectorSetupOutput,
  parseProjectCreateOutput,
  parseProjectGetOutput,
  parseProjectListOutput,
  parseProjectSelectOutput,
  projectId,
  projectRows,
  setupRows,
} from './projects';
import { chooser, within } from './testing';

// The project and connector renderers' parsers (mobile
// projects-tool-output.ts; web kortix-tool-output.ts holds the same code),
// verbatim, kept ONLY as parity oracles. Six lines differ in form only:
// `parseInt` is `Number.parseInt` (the same function), and three lines that
// CodeQL reports are simplified: `[✓✓]` is `✓`, and the two `!!nameMatch &&`
// conditions, always true after `if (!nameMatch) return null`, are dropped.
/**
 * Parsers for Kortix orchestrator tool outputs (projects, connectors).
 *
 * Port of apps/web `lib/utils/kortix-tool-output.ts`, same names and
 * semantics, for the project and connector tool renderers.
 */

// ============================================================================
// Project Tools
// ============================================================================

interface LegacyProjectEntry {
  name: string;
  path: string;
  sessions: number;
  description: string;
}

function legacyParseProjectListOutput(output: string): LegacyProjectEntry[] {
  if (!output || typeof output !== 'string') return [];
  const projects: LegacyProjectEntry[] = [];

  // Try 4-column format first: | **name** | `/path` | sessions | description |
  const fourColRe = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/gm;
  let m;
  while ((m = fourColRe.exec(output)) !== null) {
    projects.push({
      name: m[1].trim(),
      path: m[2].trim(),
      sessions: Number.parseInt(m[3], 10) || 0,
      description: m[4].trim() || '—',
    });
  }
  if (projects.length > 0) return projects;

  // Fallback: 3-column format: | **name** | `/path` | description |
  const threeColRe = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|$/gm;
  while ((m = threeColRe.exec(output)) !== null) {
    projects.push({
      name: m[1].trim(),
      path: m[2].trim(),
      sessions: 0,
      description: m[3].trim() || '—',
    });
  }
  return projects;
}

interface LegacyProjectGetData {
  name: string;
  path: string;
  description: string | null;
  id: string;
  sessions: Array<{ status: string; count: number }>;
  contextExists: boolean;
  contextPath: string;
}

function legacyParseProjectGetOutput(output: string): LegacyProjectGetData | null {
  if (!output || typeof output !== 'string') return null;

  const nameMatch = output.match(/^##\s+(.+)$/m);
  const pathMatch = output.match(/\*\*Path:\*\*\s+`([^`]+)`/);
  const descMatch = output.match(/\*\*Description:\*\*\s+(.+)$/m);
  const idMatch = output.match(/\*\*ID:\*\*\s+`([^`]+)`/);
  const contextMatch = output.match(/\*\*Context:\*\*\s+`([^`]+)`\s*(✓)?/);
  const contextExists = !!contextMatch?.[2];
  const contextPath = contextMatch?.[1] || '';

  // Sessions section
  const sessions: Array<{ status: string; count: number }> = [];
  const bulletRe = /^-\s+(running|completed|failed|pending):\s+(\d+)/gm;
  let sm;
  while ((sm = bulletRe.exec(output)) !== null) {
    sessions.push({
      status: sm[1],
      count: Number.parseInt(sm[2], 10) || 0,
    });
  }

  return {
    name: nameMatch?.[1] || 'Unknown Project',
    path: pathMatch?.[1] || '',
    description: descMatch?.[1] || null,
    id: idMatch?.[1] || '',
    sessions,
    contextExists,
    contextPath,
  };
}

interface LegacyProjectSelectData {
  name: string;
  path: string;
  success: boolean;
}

function legacyParseProjectSelectOutput(output: string): LegacyProjectSelectData | null {
  if (!output || typeof output !== 'string') return null;
  const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+selected/i);
  const pathMatch = output.match(/Path:\s+`([^`]+)`/);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    path: pathMatch?.[1] || '',
    success: output.includes('selected'),
  };
}

interface LegacyProjectCreateData {
  name: string;
  path: string;
  id: string;
  success: boolean;
}

function legacyParseProjectCreateOutput(output: string): LegacyProjectCreateData | null {
  if (!output || typeof output !== 'string') return null;
  const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+at/i);
  const pathMatch = output.match(/at\s+`([^`]+)`/);
  const idMatch = output.match(/\((proj-[^)]+)\)/);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    path: pathMatch?.[1] || '',
    id: idMatch?.[1] || '',
    success: !output.toLowerCase().includes('failed'),
  };
}

// ============================================================================
// Connector Tools
// ============================================================================

interface LegacyConnectorEntry {
  name: string;
  description: string;
  source: string;
}

function legacyParseConnectorListOutput(output: string): LegacyConnectorEntry[] {
  if (!output || typeof output !== 'string') return [];
  const connectors: LegacyConnectorEntry[] = [];
  // Parse markdown table: | Name | Description | Source |
  const lineRe = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*?)\s*\|$/gm;
  let m;
  while ((m = lineRe.exec(output)) !== null) {
    const name = m[1].trim();
    // Skip header row and separator row
    if (name === 'Name' || name.startsWith('---') || name.startsWith('–')) continue;
    connectors.push({
      name,
      description: m[2].trim(),
      source: m[3].trim(),
    });
  }
  return connectors;
}

interface LegacyConnectorGetData {
  name: string;
  description: string;
  source: string;
  env?: string;
  notes?: string;
}

function legacyParseConnectorGetOutput(output: string): LegacyConnectorGetData | null {
  if (!output || typeof output !== 'string') return null;

  const nameMatch = output.match(/^name:\s*(.+)$/m);
  const descriptionMatch = output.match(/^description:\s*(.+)$/m);
  const sourceMatch = output.match(/^source:\s*(.+)$/m);
  const envMatch = output.match(/^env:\s*(.+)$/m);
  const notesMatch = output.match(/^notes:\s*\n([\s\S]*?)$/);

  if (!nameMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descriptionMatch?.[1].trim() || '',
    source: sourceMatch?.[1].trim() || 'unknown',
    env: envMatch?.[1].trim(),
    notes: notesMatch?.[1].trim(),
  };
}

interface LegacyConnectorSetupData {
  count: number;
  connectors: string[];
  success: boolean;
}

function legacyParseConnectorSetupOutput(output: string): LegacyConnectorSetupData | null {
  if (!output || typeof output !== 'string') return null;

  // Match "Created/updated X connectors:" or legacy "Scaffolded X connectors"
  const countMatch = output.match(/(?:Created\/updated|Scaffolded)\s+(\d+)\s+connectors/i);
  const count = countMatch ? Number.parseInt(countMatch[1], 10) : 0;

  const connectors: string[] = [];
  // Parse: name (source)
  const lineRe = /^([^\s(]+)\s*\(([^)]+)\)/gm;
  let m;
  while ((m = lineRe.exec(output)) !== null) {
    connectors.push(`${m[1].trim()} (${m[2].trim()})`);
  }

  return {
    count,
    connectors,
    success: count > 0,
  };
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
const EN_DASH = String.fromCharCode(0x2013);

/** Runs `check` on 3000 texts from `make` and proves at least 600 of them matched. */
function fuzz(
  seed: number,
  make: (c: ReturnType<typeof chooser>) => string,
  check: (text: string) => boolean,
) {
  const c = chooser(seed);
  let matched = 0;
  for (let i = 0; i < 3000; i++) if (check(make(c))) matched++;
  expect(matched).toBeGreaterThan(600);
}

/** One to three rows from `bases`, each with up to three insertions from `noise`. */
function rows(
  c: ReturnType<typeof chooser>,
  bases: readonly string[],
  noise: readonly string[],
): string {
  let text = '';
  for (let line = 0, n = c.pick([1, 2, 3]); line < n; line++) {
    let row = c.pick(bases);
    for (let k = 0, m = c.pick([0, 1, 2, 3]); k < m; k++) {
      const at = Math.floor(c.next() * (row.length + 1));
      row = row.slice(0, at) + c.pick(noise) + row.slice(at);
    }
    text += row + c.pick(['\n', '\n', '\r\n', LS, '']);
  }
  return text;
}

const PROJECT_ROWS = [
  '| **app** | `/workspace/app` | 3 | Main app |',
  '| **svc** | `/w/svc` | 12 |  |',
  '|**x**|`/p`|0|d|',
  '| Name | Path | Sessions | Description |',
  '|---|---|---|---|',
  '| **app** | `/workspace/app` | Main app |',
  '| **a b** |  `/c`  |   |',
  '| **** | `/x` | 1 | d |',
];
const CONNECTOR_ROWS = [
  '| gmail | Read mail | pipedream |',
  '| Name | Description | Source |',
  '|---|---|---|',
  '|  | x | y |',
  '| a |   | c |',
  `| ${EN_DASH} | d | s |`,
];
const SETUP_LINES = [
  'gmail (pipedream)',
  'Created/updated 2 connectors:',
  '- a (b)',
  'x(y)',
  'a  (b',
  'c)',
  'Scaffolded 1 connectors',
];

describe('the project and connector readers return what their regexes returned', () => {
  test('projectRows, four and three columns', () =>
    fuzz(
      111,
      (c) => rows(c, PROJECT_ROWS, ['|', ' ', '\n', '*', '`', '\t', 'x', '3', LS, '**']),
      (text) => {
        let found = false;
        for (const columns of [3, 4] as const) {
          const re =
            columns === 4
              ? /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/gm
              : /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|$/gm;
          const expected = [...text.matchAll(re)].map((m) => m.slice(1).map((g) => g ?? ''));
          expect(projectRows(text, columns)).toEqual(expected);
          if (expected.length > 0) found = true;
        }
        return found;
      },
    ));

  test('projectId', () =>
    fuzz(
      112,
      (c) =>
        rows(
          c,
          ['Project **x** at `/w/x` (proj-abc123)', '(proj-)', '(proj-a', 'b)', '(proj-(proj-x))'],
          ['(', ')', 'proj-', '\n', 'x', ' '],
        ),
      (text) => {
        const expected = text.match(/\((proj-[^)]+)\)/)?.[1] ?? null;
        expect(projectId(text)).toBe(expected);
        return expected !== null;
      },
    ));

  test('connectorRows', () =>
    fuzz(
      113,
      (c) => rows(c, CONNECTOR_ROWS, ['|', ' ', '\n', 'x', EN_DASH, '---', '\t', '  ']),
      (text) => {
        const expected = [
          ...text.matchAll(/^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*?)\s*\|$/gm),
        ].map((m) => m.slice(1).map((g) => g ?? ''));
        expect(connectorRows(text)).toEqual(expected);
        return expected.length > 0;
      },
    ));

  test('setupRows', () =>
    fuzz(
      114,
      (c) => rows(c, SETUP_LINES, ['(', ')', ' ', '\n', 'x', '\t']),
      (text) => {
        const expected = [...text.matchAll(/^([^\s(]+)\s*\(([^)]+)\)/gm)].map((m) =>
          m.slice(1).map((g) => g ?? ''),
        );
        expect(setupRows(text)).toEqual(expected);
        return expected.length > 0;
      },
    ));
});

// Each shape `labelValue` reads: label, quantifier, `^` in front, and the
// regex it replaces. The last two are not in the parsers; they prove the
// other combinations.
const LABEL_SHAPES = [
  ['##', '+', true, /^##\s+(.+)$/m],
  ['**Description:**', '+', false, /\*\*Description:\*\*\s+(.+)$/m],
  ['name:', '*', true, /^name:\s*(.+)$/m],
  ['description:', '*', true, /^description:\s*(.+)$/m],
  ['source:', '*', true, /^source:\s*(.+)$/m],
  ['env:', '*', true, /^env:\s*(.+)$/m],
  ['env:', '+', true, /^env:\s+(.+)$/m],
  ['##', '*', false, /##\s*(.+)$/m],
] as const;
const LABELS = ['##', '**Description:**', 'name:', 'description:', 'source:', 'env:'];
const LABEL_PIECES = [...LABELS, '**Description:**Description:**', '#', 'x', 'My App'];
const SPACE_PIECES = [' ', '\t', NBSP, '\n', '\r\n', '\r', LS, PS];
const BREAKS = ['\n', '\n', '\r\n', '\r', LS, PS, '', ' ', 'x'];

describe('labelValue returns what the label regexes returned', () => {
  test('on 3000 random outputs, in every shape', () => {
    const c = chooser(116);
    const matched = LABEL_SHAPES.map(() => 0);
    let missed = 0;
    let gaveBack = 0;
    for (let i = 0; i < 3000; i++) {
      // Mostly one label, so each shape matches often enough to count.
      const focus = c.pick(LABELS);
      let text = c.pick(['', '', 'x\n', ' ']);
      for (let k = 0, n = c.pick([1, 2, 3]); k < n; k++) {
        if (k > 0) text += c.pick(BREAKS);
        text += (c.next() < 0.7 ? focus : c.pick(LABEL_PIECES)) + c.some(SPACE_PIECES, 3);
        if (c.next() < 0.3) text += c.pick(['x', 'My App', '##']);
      }
      LABEL_SHAPES.forEach(([label, space, anchored, re], shape) => {
        const expected = text.match(re)?.[1] ?? null;
        expect(labelValue(text, label, space, anchored)).toBe(expected);
        if (expected === null) missed++;
        else {
          matched[shape]++;
          // Only whitespace was left, and the quantifier gave one character back.
          if (/^\s$/.test(expected)) gaveBack++;
        }
      });
    }
    for (const count of matched) expect(count).toBeGreaterThan(300);
    expect(missed).toBeGreaterThan(10_000);
    expect(gaveBack).toBeGreaterThan(300);
  });
});

describe('the project and connector parsers return what the regex parsers returned', () => {
  test('on 3000 random outputs each', () =>
    fuzz(
      115,
      (c) => {
        const project = [
          '## My App',
          '**Path:** `/workspace/app`',
          '**Description:** The main app',
          '**ID:** `proj-123`',
          '**Context:** `/workspace/app/CONTEXT.md` ' + String.fromCharCode(0x2713),
          '- running: 2',
          '- completed: 5',
          '- failed: 1',
          'Project **app** selected',
          'Project **app** Selected',
          'Path: `/workspace/app`',
          'Project **app** at `/workspace/app` (proj-9)',
          'name: gmail',
          'description: Read mail',
          'source: pipedream',
          'env: GMAIL_TOKEN',
        ];
        return rows(
          c,
          [...PROJECT_ROWS, ...CONNECTOR_ROWS, ...SETUP_LINES, ...project],
          ['|', ' ', '\n', '(', ')', '`', '*'],
        );
      },
      (text) => {
        expect(parseProjectListOutput(text)).toEqual(legacyParseProjectListOutput(text));
        expect(parseProjectGetOutput(text)).toEqual(legacyParseProjectGetOutput(text));
        expect(parseProjectSelectOutput(text)).toEqual(legacyParseProjectSelectOutput(text));
        expect(parseProjectCreateOutput(text)).toEqual(legacyParseProjectCreateOutput(text));
        expect(parseConnectorListOutput(text)).toEqual(legacyParseConnectorListOutput(text));
        expect(parseConnectorGetOutput(text)).toEqual(legacyParseConnectorGetOutput(text));
        const setup = legacyParseConnectorSetupOutput(text);
        expect(parseConnectorSetupOutput(text)).toEqual(setup);
        return (
          legacyParseProjectListOutput(text).length > 0 ||
          legacyParseConnectorListOutput(text).length > 0 ||
          (setup?.connectors.length ?? 0) > 0
        );
      },
    ));
});

describe('the get parsers read each label as its regex did', () => {
  // Each label at a line start, with no space after it, and inside a line.
  const GET_LINES = [
    '## My App',
    '##Title',
    'a ## b',
    '**Description:** The main app',
    '**Description:**Text',
    'x **Description:** y',
    'name: gmail',
    'name:gmail',
    'x name: y',
    'description: Read mail',
    'description:d',
    'x description: y',
    'source: pipedream',
    'source:s',
    'x source: y',
    'env: GMAIL_TOKEN',
    'env:X',
    'x env: y',
  ];
  test('on 3000 random outputs', () =>
    fuzz(
      117,
      (c) => {
        const noise = [' ', '\n', '\t', LS, '#', ':', 'x'];
        return rows(c, GET_LINES, noise) + rows(c, GET_LINES, noise);
      },
      (text) => {
        const project = legacyParseProjectGetOutput(text);
        expect(parseProjectGetOutput(text)).toEqual(project);
        const connector = legacyParseConnectorGetOutput(text);
        expect(parseConnectorGetOutput(text)).toEqual(connector);
        return (
          connector !== null || project?.name !== 'Unknown Project' || project?.description !== null
        );
      },
    ));
});

describe('no project or connector output can freeze the renderer', () => {
  within('a project row whose description holds 240k spaces and never closes', () =>
    parseProjectListOutput(`| **a** | \`b\` | 1 | ${' '.repeat(240_000)}x`),
  );
  within('a three-column project row whose description holds 240k spaces', () =>
    parseProjectListOutput(`| **a** | \`b\` | ${' '.repeat(240_000)}x`),
  );
  within('40k "(proj-" that never close (240k characters)', () =>
    parseProjectCreateOutput(`Project **a** at x ${'(proj-'.repeat(40_000)}`),
  );
  within('a connector row holding 240k spaces', () =>
    parseConnectorListOutput(`|${' '.repeat(240_000)}!`),
  );
  within('80k setup lines whose ( never closes (240k characters)', () =>
    parseConnectorSetupOutput('a(\n'.repeat(80_000)),
  );
  within('"##" and 240k spaces', () => parseProjectGetOutput(`##${' '.repeat(240_000)}`));
  within('"**Description:**" and 240k line breaks', () =>
    parseProjectGetOutput(`**Description:**${'\n'.repeat(240_000)}`),
  );
  within('15k "**Description:**" with no space after (240k characters)', () =>
    parseProjectGetOutput('**Description:**'.repeat(15_000)),
  );
  within('"name:" and 240k line breaks', () =>
    parseConnectorGetOutput(`name:${'\n'.repeat(240_000)}`),
  );
  within('60k lines of "##x" (240k characters)', () =>
    parseProjectGetOutput('##x\n'.repeat(60_000)),
  );
});
