import { describe, expect, test } from 'bun:test';

import { isQuestionTool } from './session-activity-groups';

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
