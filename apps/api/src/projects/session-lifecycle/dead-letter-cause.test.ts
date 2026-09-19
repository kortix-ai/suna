import { describe, expect, test } from 'bun:test';
import { deadLetterCause, promptFailureCodeForError } from './dead-letter-cause';
import { PromptDeliveryRefused } from './prompt-delivery-refusal';
import { DELIVERY_FAILURE_CODE, DELIVERY_FAILURE_COPY, PROMPT_FAILURE_CODES } from './types';

describe('deadLetterCause', () => {
  test('the messages that actually flooded prod are customer state', () => {
    // Verbatim from Better Stack, three days to 2026-09-10 — 3,113 of 3,238
    // dead letters, all cron triggers firing into accounts that cannot pay.
    for (const message of [
      'Out of credits. Top up to continue.',
      'Your team wallet is out of credits. Top up to keep your agents running.',
      'Model "codex/gpt-5.6-sol" is not available for this account',
      'Model "deepseek-v4-flash" is not available for this account',
      'workspace mode "read" requires restricted workspace artifacts',
    ]) {
      expect(deadLetterCause(message)).toBe('customer_state');
    }
  });

  test('a dropped delivery is still the platform, and still pages', () => {
    for (const message of [
      'delivery outcome: pending',
      'delivery outcome: no-session',
      'runtime unreachable after 3 attempts',
      'Unsupported command type: frobnicate',
    ]) {
      expect(deadLetterCause(message)).toBe('platform');
    }
  });

  test('an unrecognised or empty message stays an error', () => {
    // The safe direction: only a message we recognise is demoted.
    expect(deadLetterCause('something nobody has seen before')).toBe('platform');
    expect(deadLetterCause('')).toBe('platform');
    expect(deadLetterCause(null)).toBe('platform');
    expect(deadLetterCause(undefined)).toBe('platform');
  });
});

describe('prompt failure codes', () => {
  test('the vocabulary is exactly the codes clients map', () => {
    expect([...PROMPT_FAILURE_CODES]).toEqual([
      'out_of_credits',
      'model_unavailable',
      'connector_required',
      'runtime_unreachable',
      'not_landed',
      'redelivery_exhausted',
      'rewound',
      'session_gone',
      'refused',
      'unknown',
    ]);
  });

  test('every delivery outcome the drain gives up on has one code', () => {
    // Pinned per outcome, not per message: rewording DELIVERY_FAILURE_COPY must
    // not change what a client shows.
    expect(DELIVERY_FAILURE_CODE).toEqual({
      pending: 'runtime_unreachable',
      unreachable: 'runtime_unreachable',
      'not-landed': 'not_landed',
      'no-session': 'session_gone',
      failed: 'refused',
    });
    expect(Object.keys(DELIVERY_FAILURE_CODE).sort()).toEqual(Object.keys(DELIVERY_FAILURE_COPY).sort());
  });

  test('a connector refusal is `connector_required`, by its code', () => {
    for (const code of ['CONNECTOR_CONNECTION_REQUIRED', 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE']) {
      expect(promptFailureCodeForError(new PromptDeliveryRefused(409, code, 'any wording'))).toBe(
        'connector_required',
      );
    }
  });

  test('a 402 is the billing gate, whatever its message says', () => {
    for (const message of [
      'Out of credits. Top up to continue.',
      'Subscribe to activate your seat. $40/teammate per month includes wallet credits for compute and LLM usage.',
      'No credit account found. Complete account setup first.',
    ]) {
      expect(promptFailureCodeForError(new PromptDeliveryRefused(402, 'insufficient_credits', message))).toBe(
        'out_of_credits',
      );
    }
    // `BillingGateError` is an HTTPException, not a refusal: its status is read the same way.
    expect(promptFailureCodeForError(Object.assign(new Error('Payment required'), { status: 402 }))).toBe(
      'out_of_credits',
    );
  });

  test('billing and entitlement copy is classified where the error is still in hand', () => {
    expect(promptFailureCodeForError(new Error('Out of credits. Top up to continue.'))).toBe('out_of_credits');
    expect(
      promptFailureCodeForError(new Error('Your team wallet is out of credits. Top up to keep your agents running.')),
    ).toBe('out_of_credits');
    expect(
      promptFailureCodeForError(new PromptDeliveryRefused(403, null, 'Model "codex/x" is not available for this account')),
    ).toBe('model_unavailable');
    expect(promptFailureCodeForError(new Error('Model "codex/x" is not available for this account'))).toBe(
      'model_unavailable',
    );
  });

  test('any other refusal is `refused`; anything else is `unknown`', () => {
    expect(promptFailureCodeForError(new PromptDeliveryRefused(413, null, 'Prompt rejected (HTTP 413)'))).toBe(
      'refused',
    );
    expect(
      promptFailureCodeForError(new PromptDeliveryRefused(400, null, 'workspace mode "read" requires restricted workspace artifacts')),
    ).toBe('refused');
    expect(promptFailureCodeForError(new Error('connect ECONNREFUSED'))).toBe('unknown');
    expect(promptFailureCodeForError('Out of credits')).toBe('out_of_credits');
    expect(promptFailureCodeForError(null)).toBe('unknown');
    expect(promptFailureCodeForError(undefined)).toBe('unknown');
  });
});
