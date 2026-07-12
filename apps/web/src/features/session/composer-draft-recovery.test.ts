import { describe, expect, test } from 'bun:test';

import type { AttachedFile, TrackedMention } from './session-chat-input';
import {
  mergeFailedSubmissionFiles,
  mergeFailedSubmissionMentions,
  mergeFailedSubmissionText,
} from './composer-draft-recovery';

function localFile(name: string, localUrl: string): Extract<AttachedFile, { kind: 'local' }> {
  return {
    kind: 'local',
    file: new File(['draft'], name, { type: 'text/plain' }),
    localUrl,
    isImage: false,
  };
}

describe('failed composer submission recovery', () => {
  test('restores the submitted prompt when the composer is still empty', () => {
    expect(mergeFailedSubmissionText('', 'twenty minutes of work')).toBe(
      'twenty minutes of work',
    );
  });

  test('preserves text typed while the failed request was in flight', () => {
    expect(mergeFailedSubmissionText('new follow-up', 'original prompt')).toBe(
      'original prompt\n\nnew follow-up',
    );
  });

  test('restores sent files ahead of newly attached files without duplicates', () => {
    const sent = localFile('offer.pdf', 'blob:offer');
    const addedWhileSending = localFile('notes.txt', 'blob:notes');
    expect(mergeFailedSubmissionFiles([addedWhileSending], [sent])).toEqual([
      sent,
      addedWhileSending,
    ]);
    expect(mergeFailedSubmissionFiles([sent], [sent])).toEqual([sent]);
  });

  test('restores mentions without dropping mentions added while sending', () => {
    const sent: TrackedMention = { kind: 'session', label: 'Research', value: 'ses_1' };
    const added: TrackedMention = { kind: 'agent', label: 'Analyst' };
    expect(mergeFailedSubmissionMentions([added], [sent])).toEqual([sent, added]);
  });
});
