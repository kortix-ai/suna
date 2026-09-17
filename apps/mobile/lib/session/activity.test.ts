import { describe, expect, test } from 'bun:test';
import type { Part } from '@kortix/sdk';

import {
  DISCLOSURE_UNCAPPED_HEIGHT,
  SHIMMER,
  activityIconKey,
  burstIsRunning,
  burstView,
  disclosureBodyMaxHeight,
  fileChipRun,
  fileCategory,
  fileChipTypeLabel,
  hideStepIcon,
  isFileChipPart,
  isFileChipRun,
  isStalePending,
  isToolRunning,
  isScrollPinnedToEnd,
  parseErrorContent,
  permissionLabel,
  resolveDisclosureOpen,
  samePartsList,
  scrollFades,
  shimmerBandCenter,
  shimmerSpread,
  thoughtBodyCapped,
  thoughtLabel,
  toolDisplayName,
  toolDurationMs,
  toolStreamingInput,
} from './activity';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function tool(
  name: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  state: Record<string, unknown> = {},
): Part {
  seq += 1;
  return {
    type: 'tool',
    id: `prt_${seq}`,
    callID: `call_${seq}`,
    tool: name,
    sessionID: 's',
    messageID: 'm',
    state: { status, input: {}, ...(status === 'error' ? { error: 'boom' } : {}), ...state },
  } as unknown as Part;
}

function reasoning(text: string, time: { start?: number; end?: number } = { start: 1 }): Part {
  seq += 1;
  return {
    type: 'reasoning',
    id: `prt_${seq}`,
    sessionID: 's',
    messageID: 'm',
    text,
    time,
  } as unknown as Part;
}

// ─── Thought label ───────────────────────────────────────────────────────────

describe('thoughtLabel', () => {
  test('under one second stays "Thinking" while running', () => {
    expect(thoughtLabel(true, 0)).toBe('Thinking');
    expect(thoughtLabel(true, 999)).toBe('Thinking');
  });

  test('counts up live while running', () => {
    expect(thoughtLabel(true, 1000)).toBe('Thinking for 1s');
    expect(thoughtLabel(true, 12_400)).toBe('Thinking for 12s');
  });

  test('settles on the run total when done', () => {
    expect(thoughtLabel(false, 0, 12_000)).toBe('Thought for 12s');
    expect(thoughtLabel(false, 0, 61_000)).toBe('Thought for 1m 1s');
  });

  test('a settled thought with no timing, or under one second, stays "Thinking"', () => {
    expect(thoughtLabel(false, 0)).toBe('Thinking');
    expect(thoughtLabel(false, 0, 400)).toBe('Thinking');
  });

  test('the live clock is ignored once the thought settles', () => {
    expect(thoughtLabel(false, 30_000, 2_000)).toBe('Thought for 2s');
  });
});

// ─── Disclosure rule ─────────────────────────────────────────────────────────

describe('resolveDisclosureOpen', () => {
  test('follows the automatic state until the user toggles', () => {
    expect(resolveDisclosureOpen({ auto: true })).toBe(true);
    expect(resolveDisclosureOpen({ auto: false })).toBe(false);
  });

  test('the user choice wins permanently', () => {
    expect(resolveDisclosureOpen({ userChoice: false, auto: true })).toBe(false);
    expect(resolveDisclosureOpen({ userChoice: true, auto: false })).toBe(true);
  });

  test('forceOpen wins over a closed user choice', () => {
    expect(resolveDisclosureOpen({ userChoice: false, auto: false, forceOpen: true })).toBe(true);
  });
});

// ─── Burst running ───────────────────────────────────────────────────────────

describe('burstIsRunning', () => {
  test('an idle turn is never running', () => {
    expect(burstIsRunning([tool('bash', 'running')], false, true)).toBe(false);
  });

  test('the trailing burst stays running for the whole working turn', () => {
    expect(burstIsRunning([tool('bash', 'completed')], true, true)).toBe(true);
  });

  test('an earlier burst runs only while it holds an unfinished part', () => {
    expect(burstIsRunning([tool('bash', 'completed')], true, false)).toBe(false);
    expect(burstIsRunning([tool('bash', 'pending')], true, false)).toBe(true);
    expect(burstIsRunning([reasoning('hm', { start: 1 })], true, false)).toBe(true);
    expect(burstIsRunning([reasoning('hm', { start: 1, end: 2 })], true, false)).toBe(false);
  });
});

// ─── Burst view ──────────────────────────────────────────────────────────────

describe('burstView', () => {
  test('one call is bare: no summary line', () => {
    const view = burstView([tool('bash', 'completed')], false, false);
    expect(view.bare).toBe(true);
    expect(view.hidden).toBe(false);
    expect(view.steps).toHaveLength(1);
  });

  test('a lone thought is bare too', () => {
    const view = burstView([reasoning('plan', { start: 1, end: 2 })], false, false);
    expect(view.bare).toBe(true);
    expect(view.steps[0]?.kind).toBe('thought');
  });

  test('a same-family group of 3 is ONE row but not bare — it summarises 3 calls', () => {
    const view = burstView(
      [tool('bash', 'completed'), tool('bash', 'completed'), tool('bash', 'completed')],
      false,
      false,
    );
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.kind).toBe('group');
    expect(view.bare).toBe(false);
    expect(view.title).toBe('Completed 3 steps');
  });

  test('running title counts steps without failures', () => {
    const view = burstView([tool('bash', 'error'), tool('read', 'running')], true, true);
    expect(view.running).toBe(true);
    expect(view.title).toBe('Working · 2 steps');
  });

  test('settled titles carry the failure clause', () => {
    expect(burstView([tool('bash', 'error'), tool('read', 'completed')], false, false).title).toBe(
      'Completed 1 of 2 steps · 1 failed',
    );
    expect(burstView([tool('bash', 'error'), tool('read', 'error')], false, false).title).toBe(
      '2 steps failed',
    );
  });

  test('a burst of only plumbing renders nothing', () => {
    const view = burstView([tool('get_mem', 'completed')], false, false);
    expect(view.steps).toHaveLength(0);
    expect(view.hidden).toBe(true);
  });

  test('an answered question never shares a group row', () => {
    const answered = () =>
      tool('question', 'completed', {
        input: { questions: [{ question: 'Which?' }] },
        metadata: { answers: [['A']] },
      });
    const view = burstView([answered(), answered()], false, false);
    expect(view.steps.map((s) => s.kind)).toEqual(['part', 'part']);
  });
});

// ─── Step icon ───────────────────────────────────────────────────────────────

describe('hideStepIcon', () => {
  test('a chained row always keeps its icon', () => {
    expect(hideStepIcon(tool('bash', 'completed'), false)).toBe(false);
  });

  test('a bare successful row drops its icon', () => {
    expect(hideStepIcon(tool('bash', 'completed'), true)).toBe(true);
  });

  test('a bare failed row keeps its outcome mark', () => {
    expect(hideStepIcon(tool('bash', 'error'), true)).toBe(false);
  });

  test('a bare delegate row keeps its thread anchor', () => {
    expect(hideStepIcon(tool('task', 'completed'), true)).toBe(false);
  });
});

describe('activityIconKey', () => {
  test('maps tool names to the web icon families', () => {
    expect(activityIconKey(tool('read', 'completed'))).toBe('read');
    expect(activityIconKey(tool('write', 'completed'))).toBe('edit');
    expect(activityIconKey(tool('edit', 'completed'))).toBe('edit');
    expect(activityIconKey(tool('apply_patch', 'completed'))).toBe('edit');
    expect(activityIconKey(tool('bash', 'completed'))).toBe('shell');
    expect(activityIconKey(tool('glob', 'completed'))).toBe('search');
    expect(activityIconKey(tool('grep', 'completed'))).toBe('search');
    expect(activityIconKey(tool('list', 'completed'))).toBe('list');
    expect(activityIconKey(tool('web-search', 'completed'))).toBe('web');
    expect(activityIconKey(tool('webfetch', 'completed'))).toBe('web');
    expect(activityIconKey(tool('scrape-webpage', 'completed'))).toBe('web');
    expect(activityIconKey(tool('task', 'completed'))).toBe('delegate');
    expect(activityIconKey(tool('skill', 'completed'))).toBe('skill');
    expect(activityIconKey(tool('oc-read', 'completed'))).toBe('read');
    expect(activityIconKey(tool('linear/create_issue', 'completed'))).toBe('generic');
    expect(activityIconKey(reasoning('x'))).toBe('generic');
  });
});

// ─── File chips ──────────────────────────────────────────────────────────────

describe('file chips', () => {
  const read = (path: string, status: 'completed' | 'running' | 'error' = 'completed', output = '') =>
    tool('read', status, { input: { filePath: path }, ...(status === 'completed' ? { output } : {}) });

  test('only whole-file reads and writes are chip parts', () => {
    expect(isFileChipPart(read('/a.ts'))).toBe(true);
    expect(isFileChipPart(tool('write', 'completed'))).toBe(true);
    expect(isFileChipPart(tool('edit', 'completed'))).toBe(false);
  });

  test('a chip run is one normalized tool throughout', () => {
    expect(isFileChipRun([read('/a.ts'), read('/b.ts')])).toBe(true);
    expect(isFileChipRun([read('/a.ts'), tool('grep', 'completed')])).toBe(false);
    expect(isFileChipRun([read('/a.ts'), tool('write', 'completed')])).toBe(false);
  });

  test('dedupes paths and labels the count of rows below', () => {
    const run = fileChipRun([read('/w/a.ts'), read('/w/a.ts'), read('/w/b.ts')]);
    expect(run?.paths).toEqual(['/w/a.ts', '/w/b.ts']);
    expect(run?.status).toBe('done');
    expect(run?.label).toBe('Read 2 files');
  });

  test('one clean chip names itself through toDisplayPath', () => {
    const run = fileChipRun([read('/workspace/src/a.ts')], {
      toDisplayPath: (p) => p.replace('/workspace/', ''),
    });
    expect(run?.label).toBe('Read src/a.ts');
  });

  test('failures fall back to rows and are counted in the label', () => {
    const run = fileChipRun([read('/a.ts'), read('/b.ts', 'error')]);
    expect(run?.paths).toEqual(['/a.ts']);
    expect(run?.fallbacks).toHaveLength(1);
    expect(run?.status).toBe('error');
    expect(run?.label).toBe('Read 2 files · 1 failed');
  });

  test('running wins over error and uses the participle', () => {
    const run = fileChipRun([read('/b.ts', 'error'), read('/a.ts', 'running')]);
    expect(run?.status).toBe('running');
    expect(run?.label).toBe('Reading 2 files');
  });

  test('a directory read is not a chip', () => {
    const run = fileChipRun([read('/w/src', 'completed', '<path>/w/src</path>\n<entries>\na.ts\n</entries>')]);
    expect(run?.paths).toEqual([]);
    expect(run?.fallbacks).toHaveLength(1);
    expect(fileChipRun([read('/w/src/')])?.paths).toEqual([]);
  });

  test('a bare run with no chips falls back to plain rows', () => {
    expect(fileChipRun([read('/b.ts', 'error')], { bare: true })?.bareFallback).toBe(true);
    expect(fileChipRun([read('/b.ts')], { bare: true })?.bareFallback).toBe(false);
  });

  test('a streaming call reads its path from partial raw JSON', () => {
    const part = tool('read', 'running', { input: {}, raw: '{"filePath":"/w/c.ts' });
    expect(toolStreamingInput(part)).toEqual({ filePath: '/w/c.ts' });
  });

  test('type label: extension for code and unknown, category otherwise', () => {
    expect(fileChipTypeLabel('a.ts')).toBe('TS');
    expect(fileChipTypeLabel('a.yml')).toBe('YML');
    expect(fileChipTypeLabel('photo.png')).toBe('Image');
    expect(fileChipTypeLabel('notes.md')).toBe('Markdown');
    expect(fileChipTypeLabel('Makefile')).toBe('File');
  });

  test('file category drives the chip glyph', () => {
    expect(fileCategory('a.tsx')).toBe('code');
    expect(fileCategory('a.PNG')).toBe('image');
    expect(fileCategory('a.csv')).toBe('csv');
    expect(fileCategory('a.zip')).toBe('archive');
    expect(fileCategory('Makefile')).toBe('other');
  });
});

// ─── Tool row state ──────────────────────────────────────────────────────────

describe('tool row state', () => {
  test('an input-less pending part is stale only when the turn is not live', () => {
    const part = tool('write', 'pending');
    expect(isStalePending(part, false)).toBe(true);
    expect(isStalePending(part, true)).toBe(false);
    expect(isToolRunning(part, false)).toBe(false);
    expect(isToolRunning(part, true)).toBe(true);
  });

  test('a pending part with streamed raw input is not stale', () => {
    const part = tool('write', 'pending', { raw: '{"filePath":"a' });
    expect(isStalePending(part, false)).toBe(false);
    expect(isToolRunning(part, false)).toBe(true);
  });

  test('completed and error parts are not running', () => {
    expect(isToolRunning(tool('bash', 'completed'), true)).toBe(false);
    expect(isToolRunning(tool('bash', 'error'), true)).toBe(false);
  });

  test('duration only when both ends exist and end > start', () => {
    expect(toolDurationMs(tool('bash', 'completed', { time: { start: 10, end: 2010 } }))).toBe(2000);
    expect(toolDurationMs(tool('bash', 'completed', { time: { start: 10 } }))).toBeUndefined();
    expect(toolDurationMs(tool('bash', 'completed', { time: { start: 10, end: 5 } }))).toBeUndefined();
  });

  test('error display name splits the MCP server off the tool', () => {
    expect(toolDisplayName('linear/create_issue')).toEqual({ display: 'Create Issue', server: 'linear' });
    expect(toolDisplayName('web-search')).toEqual({ display: 'Web Search', server: null });
  });

  test('permission labels match web PERMISSION_LABELS', () => {
    expect(permissionLabel('bash')).toBe('Run command');
    expect(permissionLabel('doom_loop')).toBe('Repeated tool call');
    expect(permissionLabel('custom_thing')).toBe('custom_thing');
  });
});

// ─── Error parsing ───────────────────────────────────────────────────────────

describe('parseErrorContent', () => {
  test('strips a leading "Error: " and keeps plain text as the summary', () => {
    expect(parseErrorContent('Error: ENOENT no such file')).toEqual({
      summary: 'ENOENT no such file',
      traceback: null,
      errorType: null,
      validationIssues: null,
    });
  });

  test('splits a Python traceback off the summary', () => {
    const parsed = parseErrorContent(
      'Run failed\nTraceback (most recent call last):\n  File "a.py", line 1\nValueError: bad',
    );
    expect(parsed.summary).toBe('Run failed');
    expect(parsed.errorType).toBe('ValueError');
    expect(parsed.traceback?.startsWith('Traceback')).toBe(true);
  });

  test('splits a JS stack off the summary', () => {
    const parsed = parseErrorContent('TypeError: x is undefined\n    at foo (a.js:1:1)');
    expect(parsed.summary).toBe('TypeError: x is undefined');
    expect(parsed.traceback).toBe('\n    at foo (a.js:1:1)');
  });

  test('reads validation issues from a JSON array', () => {
    const parsed = parseErrorContent(
      '[{"code":"invalid_enum","message":"Invalid option","path":["mode"],"values":["a","b"]}]',
    );
    expect(parsed.errorType).toBe('Validation Error');
    expect(parsed.summary).toBe('mode: Invalid option');
    expect(parsed.validationIssues).toEqual([
      { code: 'invalid_enum', message: 'Invalid option', path: ['mode'], values: ['a', 'b'] },
    ]);
  });

  test('a short identifier before ": " is the error type', () => {
    expect(parseErrorContent('PermissionError: denied').errorType).toBe('PermissionError');
  });
});

// ─── Memo comparison ─────────────────────────────────────────────────────────

describe('samePartsList', () => {
  test('equal when every element is the same reference, even in a new array', () => {
    const a = tool('bash', 'completed');
    const b = tool('read', 'completed');
    expect(samePartsList([a, b], [a, b])).toBe(true);
  });

  test('different on a replaced element or a length change', () => {
    const a = tool('bash', 'completed');
    expect(samePartsList([a], [tool('bash', 'completed')])).toBe(false);
    expect(samePartsList([a], [a, a])).toBe(false);
  });
});

// ─── Text shimmer geometry ───────────────────────────────────────────────────

describe('text shimmer', () => {
  test('timing matches web: 2s sweep, 0.5s hold, 250% background, 2px per character', () => {
    expect(SHIMMER.sweepMs).toBe(2000);
    expect(SHIMMER.holdMs).toBe(500);
    expect(SHIMMER.backgroundScale).toBe(2.5);
    expect(SHIMMER.spreadPerChar).toBe(2);
  });

  test('spread is text length × 2px', () => {
    expect(shimmerSpread('Thinking')).toBe(16);
  });

  test('the band centre sweeps from −0.25W to 1.25W (background-position 100% → 0%)', () => {
    expect(shimmerBandCenter(0, 200)).toBeCloseTo(-50, 5);
    expect(shimmerBandCenter(0.5, 200)).toBeCloseTo(100, 5);
    expect(shimmerBandCenter(1, 200)).toBeCloseTo(250, 5);
  });
});

// ─── Disclosure body height ──────────────────────────────────────────────────

describe('disclosure body max height', () => {
  test('fully open is uncapped, so nested opens and streaming growth are never clipped', () => {
    expect(disclosureBodyMaxHeight(1, 120)).toBe(DISCLOSURE_UNCAPPED_HEIGHT);
    // The height measured at open time is stale once content grows; it must not cap the body.
    expect(disclosureBodyMaxHeight(1, 0)).toBe(DISCLOSURE_UNCAPPED_HEIGHT);
    expect(DISCLOSURE_UNCAPPED_HEIGHT).toBeGreaterThan(100_000);
  });

  test('closed is 0', () => {
    expect(disclosureBodyMaxHeight(0, 480)).toBe(0);
  });

  test('mid-animation follows the latest measured content height × progress', () => {
    expect(disclosureBodyMaxHeight(0.5, 480)).toBeCloseTo(240, 5);
    expect(disclosureBodyMaxHeight(0.25, 800)).toBeCloseTo(200, 5);
  });

  test('out-of-range progress and negative heights clamp', () => {
    expect(disclosureBodyMaxHeight(-0.2, 480)).toBe(0);
    expect(disclosureBodyMaxHeight(1.3, 480)).toBe(DISCLOSURE_UNCAPPED_HEIGHT);
    expect(disclosureBodyMaxHeight(0.5, -10)).toBe(0);
  });
});

// ─── Thought body ────────────────────────────────────────────────────────────

describe('thought body', () => {
  test('capped only while the thought is still streaming; a finished thought shows in full', () => {
    expect(thoughtBodyCapped(true)).toBe(true);
    expect(thoughtBodyCapped(false)).toBe(false);
  });

  test('scroll fades: none when content fits, end only at the top, both mid-way, start only at the end', () => {
    expect(scrollFades(0, 100, 199)).toEqual({ start: false, end: false });
    expect(scrollFades(0, 400, 199)).toEqual({ start: false, end: true });
    expect(scrollFades(100, 400, 199)).toEqual({ start: true, end: true });
    expect(scrollFades(201, 400, 199)).toEqual({ start: true, end: false });
  });

  test('pinned to the newest text until the reader scrolls up, and again once back at the end', () => {
    expect(isScrollPinnedToEnd(0, 100, 199)).toBe(true);
    expect(isScrollPinnedToEnd(201, 400, 199)).toBe(true);
    expect(isScrollPinnedToEnd(190, 400, 199)).toBe(true);
    expect(isScrollPinnedToEnd(50, 400, 199)).toBe(false);
  });
});
