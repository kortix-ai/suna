import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const section = readFileSync(
  fileURLToPath(new URL('./session-public-link-section.tsx', import.meta.url)),
  'utf8',
);
const modal = readFileSync(
  fileURLToPath(new URL('./share-session-modal.tsx', import.meta.url)),
  'utf8',
);

describe('Share dialog public link', () => {
  test('sources are the expected modules', () => {
    expect(section).toContain('export function SessionPublicLinkSection');
    expect(modal).toContain('export function ShareSessionModal');
  });

  test('sits in the Share dialog, gated on the same verdict as the in-team picker', () => {
    expect(modal).toContain(
      '{view.canEdit && session ? (\n            <SessionPublicLinkSection projectId={projectId} sessionId={session.session_id} />',
    );
    // After the picker, inside the dialog body.
    expect(modal.indexOf('<SharingPicker')).toBeLessThan(
      modal.indexOf('<SessionPublicLinkSection'),
    );
    expect(modal.indexOf('<SessionPublicLinkSection')).toBeLessThan(modal.indexOf('</ModalBody>'));
  });

  test('creates a transcript share through the confirmed mint path', () => {
    expect(section).toContain('{ transcript: true }');
    expect(section).toContain('usePublicShareLink(');
    // Every public link is confirmed before it is minted.
    expect(section).toContain('<PublicShareLinkConfirm confirmation={link.confirmation} />');
  });

  test('shows the live link from the SDK helper, and revokes only after a confirm', () => {
    expect(section).toContain('findActiveTranscriptShare(shares)');
    expect(section).toContain('<ConfirmDialog');
    const confirm = section.slice(section.indexOf('<ConfirmDialog'));
    expect(confirm).toContain('revoke(active.share_id)');
    // The Revoke button itself only opens the confirm.
    expect(section).toContain('onClick={() => setConfirmRevoke(true)}');
  });

  test('copies the web page link, never the API proxy path', () => {
    expect(section).toContain('publicShareUrl(active.public_path)');
    expect(section).not.toContain('window.location.origin');
    expect(section).not.toContain('proxy_path');
  });
});

describe('copy feedback timer', () => {
  test('is cleared on unmount and before a restart', () => {
    expect(section).toContain('copiedTimer.current = setTimeout(');
    expect(section).toContain('if (copiedTimer.current) clearTimeout(copiedTimer.current);');
    expect(section).toContain('useEffect(\n    () => () => {');
  });
});
