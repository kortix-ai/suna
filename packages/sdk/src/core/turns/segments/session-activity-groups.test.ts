import type { ToolPart } from '../../runtime/client';
import { describe, expect, test } from 'bun:test';
import { segmentTurn } from './segment-turn';

import {
  isEmptyShowPart,
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isQuestionTool,
  isShellActivityTool,
  isStandaloneActivityTool,
  normalizeActivityToolName,
  shellActivityGroupLabel,
  writeActivityGroupLabel,
} from './session-activity-groups';

describe('normalizeActivityToolName', () => {
  test('drops the oc- alias prefix and folds kebab-case to snake_case', () => {
    expect(normalizeActivityToolName('oc-web-search')).toBe('web_search');
    expect(normalizeActivityToolName('bash')).toBe('bash');
  });

  test('an absent name normalizes to the empty string', () => {
    expect(normalizeActivityToolName(undefined)).toBe('');
  });
});

describe('group labels', () => {
  test('shell groups count commands in the right tense', () => {
    expect(isShellActivityTool('oc-bash')).toBe(true);
    expect(isShellActivityTool('read')).toBe(false);
    expect(shellActivityGroupLabel(1, false)).toBe('Ran 1 command');
    expect(shellActivityGroupLabel(3, true)).toBe('Running 3 commands');
    expect(shellActivityGroupLabel(-2, false)).toBe('Ran 0 commands');
  });

  test('write groups count files in the right tense', () => {
    expect(writeActivityGroupLabel(1, true)).toBe('Writing 1 file');
    expect(writeActivityGroupLabel(2, false)).toBe('Wrote 2 files');
  });
});

describe('grouping exemptions', () => {
  test('show and show_user never fold into a group', () => {
    expect(isNoGroupActivityTool('show')).toBe(true);
    expect(isNoGroupActivityTool('show-user')).toBe(true);
    expect(isNoGroupActivityTool('read')).toBe(false);
  });

  test('deliverables and sub-agents always render standalone', () => {
    expect(isStandaloneActivityTool('show')).toBe(true);
    expect(isStandaloneActivityTool('oc-agent-spawn')).toBe(true);
    expect(isStandaloneActivityTool('agent_stop')).toBe(true);
    expect(isStandaloneActivityTool('bash')).toBe(false);
  });
});

describe('image_gen is a deliverable', () => {
  test('image_gen never folds into a burst group', () => {
    for (const name of ['image_gen', 'image-gen', 'oc-image-gen']) {
      expect(isNoGroupActivityTool(name)).toBe(true);
      expect(isStandaloneActivityTool(name)).toBe(true);
    }
  });

  test('image_gen between two shells splits them and stands alone', () => {
    const call = (id: string, name: string) =>
      ({ id, type: 'tool', tool: name, callID: `c${id}`, state: { status: 'completed', input: {} } }) as unknown as ToolPart;
    const segments = segmentTurn([call('1', 'bash'), call('2', 'image_gen'), call('3', 'bash')]);

    expect(segments.map((seg) => seg.kind)).toEqual(['burst', 'standalone', 'burst']);
    expect((segments[1] as { part: ToolPart }).part.id).toBe('2');
  });
});

describe('isInvisibleActivityPart', () => {
  test('bookkeeping parts and blank text render nothing', () => {
    expect(isInvisibleActivityPart({ type: 'snapshot' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'patch' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'step-start' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'step-finish' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '   ' })).toBe(true);
  });

  test('real text and real tool calls are visible', () => {
    expect(isInvisibleActivityPart({ type: 'text', text: 'hello' })).toBe(false);
    expect(
      isInvisibleActivityPart({ type: 'tool', tool: 'read', state: { status: 'completed' } }),
    ).toBe(false);
  });

  test('a settled show with no artifact is invisible', () => {
    expect(
      isInvisibleActivityPart({
        type: 'tool',
        tool: 'show',
        state: { status: 'completed', input: { type: 'markdown' } },
      }),
    ).toBe(true);
  });
});

/** The memory tool's real `view` output for an empty memory folder: the root line only. */
const EMPTY_MEMORY_VIEW =
  "Here're the files and directories up to 2 levels deep in memory, excluding hidden items and node_modules:\n4K\tmemory";

const memoryPart = (status: string, input: Record<string, unknown>, output?: string) => ({
  type: 'tool',
  tool: 'memory',
  state: { status, input, output },
});

describe('the empty memory read', () => {
  test('an empty memory view is invisible', () => {
    expect(isInvisibleActivityPart(memoryPart('completed', { command: 'view', path: 'memory' }, EMPTY_MEMORY_VIEW))).toBe(true);
    // The same listing when the agent asked for `memory/`.
    expect(
      isInvisibleActivityPart(
        memoryPart('completed', { command: 'view', path: 'memory/' }, EMPTY_MEMORY_VIEW.replace('in memory', 'in memory/').replace('\tmemory', '\tmemory/')),
      ),
    ).toBe(true);
    expect(
      isInvisibleActivityPart({ ...memoryPart('completed', { command: 'view', path: 'memory' }, EMPTY_MEMORY_VIEW), tool: 'oc-memory' }),
    ).toBe(true);
  });

  test('a memory view that lists a file stays visible', () => {
    expect(
      isInvisibleActivityPart(memoryPart('completed', { command: 'view', path: 'memory' }, `${EMPTY_MEMORY_VIEW}\n1.2K\tmemory/overview.md`)),
    ).toBe(false);
    expect(
      isInvisibleActivityPart(
        memoryPart('completed', { command: 'view', path: 'memory/overview.md' }, "Here's the content of memory/overview.md with line numbers:\n1\t# Overview"),
      ),
    ).toBe(false);
  });

  test('a running or failed memory call stays visible', () => {
    expect(isInvisibleActivityPart(memoryPart('running', { command: 'view', path: 'memory' }))).toBe(false);
    expect(isInvisibleActivityPart(memoryPart('error', { command: 'view', path: 'memory' }, EMPTY_MEMORY_VIEW))).toBe(false);
    expect(
      isInvisibleActivityPart(
        memoryPart('completed', { command: 'view', path: 'memory/nope' }, 'The path memory/nope does not exist. Please provide a valid path.'),
      ),
    ).toBe(false);
  });

  test('a memory write is never the empty read', () => {
    expect(isInvisibleActivityPart(memoryPart('completed', { command: 'create', path: 'memory' }, EMPTY_MEMORY_VIEW))).toBe(false);
  });

  test('segmentation drops the empty read, so it cannot split a burst', () => {
    const read = (id: string): ToolPart =>
      ({ id, type: 'tool', tool: 'read', callID: id, state: { status: 'completed', input: {}, output: '' } }) as unknown as ToolPart;
    const memory = {
      id: 'm',
      type: 'tool',
      tool: 'memory',
      callID: 'm',
      state: { status: 'completed', input: { command: 'view', path: 'memory' }, output: EMPTY_MEMORY_VIEW },
    } as unknown as ToolPart;
    const segments = segmentTurn([read('a'), memory, read('b')]);
    const parts = segments.flatMap((s) => ('parts' in s ? s.parts : [s.part]));
    expect(parts.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('isEmptyShowPart', () => {
  test('only a completed show without an artifact is empty', () => {
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'completed', input: {} } })).toBe(true);
    expect(
      isEmptyShowPart({ tool: 'show_user', state: { status: 'completed', input: { path: 'a.md' } } }),
    ).toBe(false);
  });

  test('a running or errored show is never empty — it has content to show', () => {
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'running', input: {} } })).toBe(false);
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'error', input: {} } })).toBe(false);
  });

  test('a carousel is empty only when no item carries an artifact', () => {
    expect(
      isEmptyShowPart({
        tool: 'show',
        state: { status: 'completed', input: { items: '[{"title":"x"}]' } },
      }),
    ).toBe(true);
    expect(
      isEmptyShowPart({
        tool: 'show',
        state: { status: 'completed', input: { items: [{ title: 'x' }, { url: 'https://a.io' }] } },
      }),
    ).toBe(false);
  });

  test('a non-show tool is never an empty show', () => {
    expect(isEmptyShowPart({ tool: 'read', state: { status: 'completed', input: {} } })).toBe(false);
  });
});

/**
 * Two layers already agree that `ask` and `question` are the same tool:
 *
 *   - the SDK's view model maps both to `questionViewModel`
 *     (`packages/sdk/src/core/turns/view-model.ts`);
 *   - the web renders both with `QuestionTool`
 *     (`ToolRegistry.register('question'|'ask', QuestionTool)`).
 *
 * The transcript's gates did not. Every one of them compared
 * `part.tool === 'question'` literally, so a part named `ask` rendered AS a
 * question while being treated as an ordinary tool everywhere else: it was not
 * dropped by the pending-question filter, it counted towards `hasSteps`, it
 * never became an answered-question card, and the question self-heal never
 * re-hydrated it. The visible symptom is a turn body showing the tool's
 * half-parsed arguments — a question cut mid-sentence, with its markdown
 * unclosed, because partial-JSON repair closes a string that stopped early.
 *
 * One predicate, so the gates agree with the two layers that already did.
 */
describe('isQuestionTool', () => {
  test('the canonical name', () => {
    expect(isQuestionTool('question')).toBe(true);
  });

  test('`ask` is the same tool — both render as QuestionTool', () => {
    expect(isQuestionTool('ask')).toBe(true);
  });

  test('the opencode-prefixed wire names normalize too', () => {
    expect(isQuestionTool('oc-question')).toBe(true);
    expect(isQuestionTool('oc-ask')).toBe(true);
  });

  test('nothing else is a question tool', () => {
    expect(isQuestionTool('task')).toBe(false);
    expect(isQuestionTool('bash')).toBe(false);
    expect(isQuestionTool('todowrite')).toBe(false);
    expect(isQuestionTool('asking')).toBe(false);
    expect(isQuestionTool('questionnaire')).toBe(false);
  });

  test('a missing name is not a question tool', () => {
    expect(isQuestionTool(undefined)).toBe(false);
    expect(isQuestionTool('')).toBe(false);
  });
});
