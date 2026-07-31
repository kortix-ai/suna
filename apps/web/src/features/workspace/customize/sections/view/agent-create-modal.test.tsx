import { describe, expect, test } from 'bun:test';
import { ApiError } from '@kortix/sdk';

import {
  agentCreateFingerprint,
  canSubmitAgentCreateDraft,
  initialCreateAgentBlock,
  isAgentPreviewStale,
  isStalePreviewRevisionError,
  validateAgentCreateDraft,
} from './agent-create-modal';

describe('agent create validation', () => {
  test('requires a valid lowercase agent name and a prompt body', () => {
    expect(validateAgentCreateDraft('', initialCreateAgentBlock())).toEqual({
      agentName: 'Agent name is required.',
      prompt: 'System prompt is required.',
    });

    expect(
      validateAgentCreateDraft('Reliance CTO', {
        opencode: { mode: 'primary', prompt: 'You are the CTO.' },
      }),
    ).toEqual({
      agentName: 'Use lowercase letters, numbers, dashes, or underscores.',
    });

    expect(
      validateAgentCreateDraft('reliance-cto', {
        opencode: { mode: 'primary', prompt: 'You are the CTO.' },
      }),
    ).toEqual({});
  });

  test('marks a preview stale after the draft changes', () => {
    const ready = agentCreateFingerprint('reliance-cto', {
      opencode: { mode: 'primary', prompt: 'You are the CTO.' },
    });
    const changed = agentCreateFingerprint('reliance-cto', {
      opencode: { mode: 'primary', prompt: 'You are the CTO. Review releases.' },
    });

    expect(isAgentPreviewStale(null, ready)).toBe(true);
    expect(isAgentPreviewStale(ready, ready)).toBe(false);
    expect(isAgentPreviewStale(ready, changed)).toBe(true);
  });
});

describe('agent create submit state', () => {
  test('requires a fresh reviewed preview before create can submit', () => {
    const ready = {
      valid: true,
      hasPreview: true,
      previewStale: false,
      createPending: false,
      previewPending: false,
      canCreate: true,
      hasResult: false,
    };

    expect(canSubmitAgentCreateDraft(ready)).toBe(true);
    expect(canSubmitAgentCreateDraft({ ...ready, hasPreview: false })).toBe(false);
    expect(canSubmitAgentCreateDraft({ ...ready, previewStale: true })).toBe(false);
    expect(canSubmitAgentCreateDraft({ ...ready, canCreate: false })).toBe(false);
    expect(canSubmitAgentCreateDraft({ ...ready, hasResult: true })).toBe(false);
  });

  test('stale preview API errors are detected by code', () => {
    expect(
      isStalePreviewRevisionError(
        new ApiError('Preview is stale', { status: 409, code: 'stale_preview_revision' }),
      ),
    ).toBe(true);
    expect(isStalePreviewRevisionError(new Error('Preview is stale'))).toBe(false);
  });
});
