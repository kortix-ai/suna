import { describe, expect, test } from 'bun:test';

import {
  pendingSessionPromptFromMetadata,
  provisioningFailurePresentation,
  startStashFromPendingSessionPrompt,
} from './provisioning-failure';

describe('provisioningFailurePresentation', () => {
  test('shows a specific capacity title and the API-owned message', () => {
    expect(
      provisioningFailurePresentation({
        failureCategory: 'provider-capacity',
        provisioningError: 'provider SDK text that must stay diagnostic-only',
        errorMessage: 'The sandbox provider is at capacity right now. Try again in a minute.',
      }),
    ).toEqual({
      title: 'Sandbox capacity is full',
      message: 'The sandbox provider is at capacity right now. Try again in a minute.',
      retryable: true,
      isCapacity: true,
    });
  });

  test('shows Git failures as Git failures', () => {
    const result = provisioningFailurePresentation({
      failureCategory: 'git-auth',
      errorMessage: 'Check the Git credentials.',
    });

    expect(result.title).toBe('Git access failed');
    expect(result.message).toBe('Check the Git credentials.');
  });

  test('uses provider-neutral fallback copy', () => {
    expect(provisioningFailurePresentation({}, 'Essentia runtime')).toEqual({
      title: "Couldn't start Essentia runtime",
      message: 'The sandbox provider could not start this session. Try again.',
      retryable: true,
      isCapacity: false,
    });
  });
});

describe('startStashFromPendingSessionPrompt', () => {
  test('restores the durable prompt only through the explicit Retry path', () => {
    expect(
      startStashFromPendingSessionPrompt({
        text: 'Map this parcel.',
        agent: 'gis',
        model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
        variant: 'high',
        attachment_names: ['parcel.geojson'],
      }),
    ).toEqual({
      prompt: 'Map this parcel.',
      agent: 'gis',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
    });
  });
});

describe('pendingSessionPromptFromMetadata', () => {
  test('reads a durable prompt and its delivery options', () => {
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: {
          text: 'Map this parcel.',
          agent: 'gis',
          model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
          variant: 'high',
          attachment_names: ['parcel.geojson'],
        },
      }),
    ).toEqual({
      text: 'Map this parcel.',
      agent: 'gis',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      attachment_names: ['parcel.geojson'],
    });
  });

  test('reads a file-only recovery copy with empty text', () => {
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: '', attachment_names: ['parcel.geojson'] },
      }),
    ).toEqual({
      text: '',
      agent: null,
      model: null,
      variant: null,
      attachment_names: ['parcel.geojson'],
    });
  });

  test('rejects missing, cleared, content-free, and malformed recovery copies', () => {
    expect(pendingSessionPromptFromMetadata(undefined)).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: null })).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: [] })).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: { text: '   ' } })).toBeNull();
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: 'Map this parcel.', model: { providerID: 'kortix' } },
      }),
    ).toBeNull();
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: 'Map this parcel.', attachment_names: [42] },
      }),
    ).toBeNull();
  });
});
