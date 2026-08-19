import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  pendingSessionPromptFromMetadata,
  provisioningFailurePresentation,
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
    });
  });

  test('shows Git failures as Git failures', () => {
    const result = provisioningFailurePresentation({
      failureCategory: 'git-auth',
      errorMessage: 'Check the Git credentials.',
    });

    expect(result.title).toBe('Git access failed');
    expect(result.message).toBe('Check the Git credentials.');
    expect(result.retryable).toBe(true);
  });

  test('uses provider-neutral fallback copy', () => {
    expect(provisioningFailurePresentation({}, 'Essentia runtime')).toEqual({
      title: "Couldn't start Essentia runtime",
      message: 'The sandbox provider could not start this session. Try again.',
      retryable: true,
    });
  });
});

describe('project session provider-failure recovery', () => {
  const pageSource = readFileSync(
    resolve(import.meta.dir, '../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx'),
    'utf8',
  );
  const recoverySource = readFileSync(
    resolve(import.meta.dir, './provider-failure-recovery.tsx'),
    'utf8',
  );

  test('routes structured provider failures and generic start errors through one surface', () => {
    expect(pageSource).toContain('const recoverableFailure =');
    expect(pageSource).toContain('session.failure');
    expect(pageSource).toContain('session.startError');
    expect(pageSource).toContain('if (unmaterializedFailure)');
    expect(pageSource).toContain('<ProviderFailureRecovery');
  });

  test('shows the saved prompt and exposes one-click recovery controls', () => {
    expect(recoverySource).toContain('Saved prompt');
    expect(recoverySource).toContain('{pendingPrompt.text}');
    expect(recoverySource).toContain('whitespace-pre-wrap');
    expect(recoverySource).toContain('Copy prompt');
    expect(recoverySource).toContain('onClick={onRetry}');
    expect(recoverySource).toContain('onClick={onDelete}');
  });
});

describe('the retry path queues the durable row itself', () => {
  test('no stash builder survives — a legacy hand-off is POSTed, never re-stashed', () => {
    // `startStashFromPendingSessionPrompt` re-created the browser hand-off on
    // Retry, which kept the prompt losable for one more boot. The session page
    // now POSTs a legacy `pending_prompt.text` straight to the inbox
    // (`startSessionWithPrompt`) and strips the metadata copy; a session
    // created by the current API never enters this path at all — its first
    // prompt has been a durable row since the create transaction.
    const source = readFileSync(resolve(import.meta.dir, './provisioning-failure.ts'), 'utf8');
    expect(source).not.toContain('startStashFromPendingSessionPrompt');
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
