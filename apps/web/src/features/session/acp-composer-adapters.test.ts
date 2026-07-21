import { describe, expect, test } from 'bun:test';
import type { AcpPendingQuestion, AcpSessionConfigOption } from '@kortix/sdk';
import {
  acpConfigOptionPresets,
  acpTodosFromPlanEntries,
  buildAcpQuestionContent,
  findAcpModelConfigOption,
  isAcpModelConfigOption,
  isWritableAcpModelConfigOption,
  otherAcpConfigOptions,
  resolveDeferredModelApply,
  shouldAttemptDeferredModelApply,
  toQuestionRequest,
} from './acp-composer-adapters';

describe('isAcpModelConfigOption', () => {
  test('matches on id, category, or name mentioning "model"', () => {
    expect(isAcpModelConfigOption({ id: 'model' })).toBe(true);
    expect(isAcpModelConfigOption({ id: 'opt-1', category: 'model' })).toBe(true);
    expect(isAcpModelConfigOption({ id: 'opt-1', name: 'Model' })).toBe(true);
  });

  test('does not match unrelated options', () => {
    expect(isAcpModelConfigOption({ id: 'reasoning_effort', name: 'Reasoning effort' })).toBe(
      false,
    );
  });
});

describe('findAcpModelConfigOption', () => {
  test('returns the first model-typed option', () => {
    const options: AcpSessionConfigOption[] = [
      { id: 'reasoning_effort' },
      { id: 'model', name: 'Model' },
    ];
    expect(findAcpModelConfigOption(options)?.id).toBe('model');
  });

  test('returns null when no option matches', () => {
    expect(findAcpModelConfigOption([{ id: 'reasoning_effort' }])).toBeNull();
  });
});

describe('otherAcpConfigOptions', () => {
  // Real payload shape (verified live against codex-acp, local DB, 2026-07-22).
  const MODE: AcpSessionConfigOption = { id: 'mode', type: 'select', options: [{ value: 'agent', name: 'Agent' }] };
  const MODEL: AcpSessionConfigOption = { id: 'model', type: 'select', options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }] };
  const REASONING: AcpSessionConfigOption = {
    id: 'reasoning_effort',
    type: 'select',
    options: [{ value: 'low', name: 'Low' }],
  };

  test('excludes the model option by reference, keeps every other select/mode option with real choices', () => {
    const result = otherAcpConfigOptions([MODE, MODEL, REASONING], MODEL);
    expect(result).toEqual([MODE, REASONING]);
  });

  test('a null modelOption (harness declared none) still filters correctly — nothing to exclude by reference', () => {
    expect(otherAcpConfigOptions([MODE, REASONING], null)).toEqual([MODE, REASONING]);
  });

  test('drops an option with zero choices — nothing to pick, never a dead pill', () => {
    const empty: AcpSessionConfigOption = { id: 'empty', type: 'select', options: [] };
    expect(otherAcpConfigOptions([MODE, empty], null)).toEqual([MODE]);
  });

  test('drops a non-select/mode-typed option', () => {
    const info: AcpSessionConfigOption = { id: 'info', type: 'info', options: [{ value: 'x', name: 'X' }] };
    expect(otherAcpConfigOptions([MODE, info], null)).toEqual([MODE]);
  });
});

describe('isWritableAcpModelConfigOption', () => {
  // Real payload shape (verified live against claude-agent-acp,
  // `kortix.acp_session_envelopes`, dev DB, 2026-07-21).
  const claudeModelOption: AcpSessionConfigOption = {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'default',
    options: [
      { name: 'Default (recommended)', value: 'default' },
      { name: 'Sonnet', value: 'sonnet' },
      { name: 'Opus', value: 'opus' },
      { name: 'Haiku', value: 'haiku' },
    ],
  };

  test('a real select-typed model option with choices is writable', () => {
    expect(isWritableAcpModelConfigOption(claudeModelOption)).toBe(true);
  });

  test('null is never writable', () => {
    expect(isWritableAcpModelConfigOption(null)).toBe(false);
  });

  test('a select-typed option with zero choices is not writable — nothing to pick, degrades to the label', () => {
    expect(isWritableAcpModelConfigOption({ ...claudeModelOption, options: [] })).toBe(false);
  });

  test('a non-select type (e.g. a future free-text option) is not writable', () => {
    expect(isWritableAcpModelConfigOption({ ...claudeModelOption, type: 'text' })).toBe(false);
  });

  test('a missing type is treated leniently as writable when choices exist', () => {
    const { type: _type, ...withoutType } = claudeModelOption;
    expect(isWritableAcpModelConfigOption(withoutType)).toBe(true);
  });
});

describe('acpConfigOptionPresets', () => {
  test('maps generic config option entries into harness-model-selector presets', () => {
    const option: AcpSessionConfigOption = {
      id: 'model',
      options: [
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      ],
    };
    expect(acpConfigOptionPresets(option)).toEqual([
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', source: 'session' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', source: 'session' },
    ]);
  });

  test('returns an empty list when the option has no choices', () => {
    expect(acpConfigOptionPresets(null)).toEqual([]);
    expect(acpConfigOptionPresets({ id: 'model' })).toEqual([]);
  });
});

describe('acpTodosFromPlanEntries', () => {
  test('normalizes ACP plan entries into TodoChip shape', () => {
    const entries = [
      { content: 'Read the file', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
    ];
    expect(acpTodosFromPlanEntries(entries)).toEqual([
      { id: '0', content: 'Read the file', status: 'completed' },
      { id: '1', content: 'Write the fix', status: 'in_progress' },
    ]);
  });

  test('degrades gracefully for non-object entries', () => {
    expect(acpTodosFromPlanEntries(['do the thing'])).toEqual([
      { id: '0', content: 'do the thing', status: 'pending' },
    ]);
  });

  test('returns an empty list for no entries', () => {
    expect(acpTodosFromPlanEntries(undefined)).toEqual([]);
    expect(acpTodosFromPlanEntries([])).toEqual([]);
  });
});

describe('resolveDeferredModelApply', () => {
  // Real payload shape (verified live against claude-agent-acp,
  // `kortix.acp_session_envelopes`, dev DB, 2026-07-21).
  const modelOption: AcpSessionConfigOption = {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'default',
    options: [
      { name: 'Default (recommended)', value: 'default' },
      { name: 'Sonnet', value: 'sonnet' },
      { name: 'Opus', value: 'opus' },
      { name: 'Haiku', value: 'haiku' },
    ],
  };

  test('applies a deferred pick that differs from currentValue and is advertised', () => {
    expect(resolveDeferredModelApply({ deferredValue: 'opus', option: modelOption })).toBe('opus');
  });

  test('drops a deferred pick the harness never advertised — a stale pick from an old adapter version', () => {
    expect(resolveDeferredModelApply({ deferredValue: 'gpt-5.4', option: modelOption })).toBeNull();
  });

  test('no-ops when the deferred pick already matches currentValue — nothing to apply', () => {
    expect(resolveDeferredModelApply({ deferredValue: 'default', option: modelOption })).toBeNull();
  });

  test('no-ops when there is no deferred pick at all', () => {
    expect(resolveDeferredModelApply({ deferredValue: null, option: modelOption })).toBeNull();
    expect(resolveDeferredModelApply({ deferredValue: undefined, option: modelOption })).toBeNull();
  });

  test('never applies against a non-writable option (no session to apply to yet)', () => {
    expect(resolveDeferredModelApply({ deferredValue: 'opus', option: null })).toBeNull();
    expect(
      resolveDeferredModelApply({ deferredValue: 'opus', option: { ...modelOption, options: [] } }),
    ).toBeNull();
  });
});

describe('shouldAttemptDeferredModelApply', () => {
  test('attempts once a writable option is available for a real session that has not been attempted yet', () => {
    expect(
      shouldAttemptDeferredModelApply({
        sessionId: 'session-1',
        alreadyAttemptedSessionId: null,
        optionAvailable: true,
      }),
    ).toBe(true);
  });

  test('never attempts without a session id', () => {
    expect(
      shouldAttemptDeferredModelApply({
        sessionId: undefined,
        alreadyAttemptedSessionId: null,
        optionAvailable: true,
      }),
    ).toBe(false);
  });

  test('never attempts before the writable option has arrived', () => {
    expect(
      shouldAttemptDeferredModelApply({
        sessionId: 'session-1',
        alreadyAttemptedSessionId: null,
        optionAvailable: false,
      }),
    ).toBe(false);
  });

  test('a later live change is never clobbered by re-sending a stale deferred pick — already-attempted sessions never re-attempt', () => {
    // Simulates: the deferred pick applied once, the user (or the harness
    // itself, via config_option_update) later changed the live value — the
    // effect must NOT fire again for the same session and re-send the old
    // deferred pick over the harness's own subsequent choice.
    expect(
      shouldAttemptDeferredModelApply({
        sessionId: 'session-1',
        alreadyAttemptedSessionId: 'session-1',
        optionAvailable: true,
      }),
    ).toBe(false);
  });

  test('a NEW session (different id) gets its own fresh attempt', () => {
    expect(
      shouldAttemptDeferredModelApply({
        sessionId: 'session-2',
        alreadyAttemptedSessionId: 'session-1',
        optionAvailable: true,
      }),
    ).toBe(true);
  });
});

describe('toQuestionRequest / buildAcpQuestionContent', () => {
  const pending: AcpPendingQuestion = {
    id: 'q1',
    method: 'elicitation/create',
    questions: [
      {
        key: 'environment',
        question: 'Which environment?',
        options: [
          { optionId: 'staging', label: 'staging', value: 'staging' },
          { optionId: 'production', label: 'production', value: 'production' },
        ],
      },
    ],
    params: {},
  };

  test('projects into a harness-neutral QuestionRequest', () => {
    const request = toQuestionRequest(pending, 'session-1');
    expect(request).toEqual({
      id: 'q1',
      sessionID: 'session-1',
      questions: [
        {
          question: 'Which environment?',
          header: undefined,
          options: [
            { label: 'staging', description: undefined },
            { label: 'production', description: undefined },
          ],
          multiple: false,
          custom: true,
        },
      ],
    });
  });

  test('maps a chosen option label back to its real value, keyed by the question key', () => {
    expect(buildAcpQuestionContent(pending, [['staging']])).toEqual({ environment: 'staging' });
  });

  test('falls back to the raw typed text when it matches no option', () => {
    expect(buildAcpQuestionContent(pending, [['us-east']])).toEqual({ environment: 'us-east' });
  });

  test('falls back to a positional key when the question has none', () => {
    const noKey: AcpPendingQuestion = {
      ...pending,
      questions: [{ ...pending.questions[0]!, key: undefined }],
    };
    expect(buildAcpQuestionContent(noKey, [['staging']])).toEqual({ answer_1: 'staging' });
  });

  test('sends an array when multiple answers are collected for one question', () => {
    expect(buildAcpQuestionContent(pending, [['staging', 'production']])).toEqual({
      environment: ['staging', 'production'],
    });
  });
});
