import { describe, expect, test } from 'bun:test';
import type { AcpPendingQuestion, AcpSessionConfigOption } from '@kortix/sdk';
import {
  acpConfigOptionPresets,
  acpTodosFromPlanEntries,
  buildAcpQuestionContent,
  findAcpModelConfigOption,
  isAcpModelConfigOption,
  toQuestionRequest,
} from './acp-composer-adapters';

describe('isAcpModelConfigOption', () => {
  test('matches on id, category, or name mentioning "model"', () => {
    expect(isAcpModelConfigOption({ id: 'model' })).toBe(true);
    expect(isAcpModelConfigOption({ id: 'opt-1', category: 'model' })).toBe(true);
    expect(isAcpModelConfigOption({ id: 'opt-1', name: 'Model' })).toBe(true);
  });

  test('does not match unrelated options', () => {
    expect(isAcpModelConfigOption({ id: 'reasoning_effort', name: 'Reasoning effort' })).toBe(false);
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
    const noKey: AcpPendingQuestion = { ...pending, questions: [{ ...pending.questions[0]!, key: undefined }] };
    expect(buildAcpQuestionContent(noKey, [['staging']])).toEqual({ answer_1: 'staging' });
  });

  test('sends an array when multiple answers are collected for one question', () => {
    expect(buildAcpQuestionContent(pending, [['staging', 'production']])).toEqual({
      environment: ['staging', 'production'],
    });
  });
});
