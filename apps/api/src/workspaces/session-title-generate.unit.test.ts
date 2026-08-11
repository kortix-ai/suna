import { describe, expect, test } from 'bun:test';

import {
  sanitizeGeneratedTitle,
  titleCompletionBody,
  TITLE_SOURCE_MAX_CHARS,
} from './session-title-generate';

describe('titleCompletionBody', () => {
  test('grants reasoning models enough completion budget to emit content', () => {
    const body = JSON.parse(titleCompletionBody('glm-5.2', 'Create a demo PDF about cats.'));
    // Reasoning models (GLM, DeepSeek, o-series) spend tokens on `reasoning`
    // BEFORE `content`. A tight cap (the old 24) returned finish_reason
    // "length" with an empty content — and the session stayed untitled
    // forever. The floor here is the regression guard.
    expect(body.max_tokens).toBeGreaterThanOrEqual(128);
    expect(body.model).toBe('glm-5.2');
    expect(body.stream).toBe(false);
    // The message is quoted as DATA inside a titling instruction — passed
    // bare, smaller models answer it (emit code) instead of titling it.
    expect(body.messages[1].content).toContain('Create a demo PDF about cats.');
    expect(body.messages[1].content).toMatch(/only the title/i);
    expect(body.messages[1].content).toMatch(/Do NOT answer/i);
  });

  test('truncates oversized prompt text', () => {
    const body = JSON.parse(titleCompletionBody('glm-5.2', 'x'.repeat(TITLE_SOURCE_MAX_CHARS + 500)));
    expect(body.messages[1].content).not.toContain('x'.repeat(TITLE_SOURCE_MAX_CHARS + 1));
    expect(body.messages[1].content).toContain('x'.repeat(TITLE_SOURCE_MAX_CHARS));
  });
});

describe('sanitizeGeneratedTitle', () => {
  test('an empty completion (reasoning-only response) yields null, not an empty title', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull();
    expect(sanitizeGeneratedTitle('   ')).toBeNull();
  });

  test('strips wrapping quotes and collapses whitespace', () => {
    expect(sanitizeGeneratedTitle('"Cat  Demo\nPDF"')).toBe('Cat Demo PDF');
  });

  test('rejects a code-fenced task attempt outright', () => {
    expect(sanitizeGeneratedTitle('```python\nimport subprocess\n```')).toBeNull();
  });
});
