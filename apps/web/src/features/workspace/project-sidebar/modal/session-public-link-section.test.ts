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

  test('an active share also offers the embed snippet (KRTX-2358)', () => {
    // The snippet is the same public path through the embed helper, so the
    // iframe can never drift from the link the visitor opens.
    expect(section).toContain('embedChatUrl(active.public_path)');
    // The affordance only exists while a snippet exists, copies the snippet
    // (not the bare URL), and its copied feedback is its own state, separate
    // from the page link's.
    expect(section).toContain('{embedSnippet ? (');
    expect(section).toContain("aria-label={t('embed')}");
    expect(section).toContain('onClick={() => void copyEmbed()}');
    expect(section).toContain("embedCopied ? t('embedCopied') : t('embed')");
  });
});

describe('copy feedback timer', () => {
  test('is cleared on unmount and before a restart', () => {
    expect(section).toContain('copiedTimer.current = setTimeout(');
    expect(section).toContain('if (copiedTimer.current) clearTimeout(copiedTimer.current);');
    expect(section).toContain('useEffect(\n    () => () => {');
  });

  test('each copied flag owns its timer, so one copy never cancels the other reset', () => {
    const copy = section.slice(
      section.indexOf('const copy = async () => {'),
      section.indexOf('const copyEmbed = async () => {'),
    );
    const copyEmbed = section.slice(
      section.indexOf('const copyEmbed = async () => {'),
      section.indexOf('return ('),
    );
    const unmount = section.slice(section.indexOf('useEffect('), section.indexOf('const active ='));
    // A shared timer lets the second copy cancel the first flag's reset and
    // stick its check until the next click.
    expect(copy).toContain('copiedTimer.current = setTimeout(() => setCopied(false)');
    expect(copy).not.toContain('setEmbedCopied');
    expect(copy).not.toContain('embedCopiedTimer');
    expect(copyEmbed).toContain(
      'embedCopiedTimer.current = setTimeout(() => setEmbedCopied(false)',
    );
    expect(copyEmbed).not.toContain('setCopied(');
    expect(copyEmbed).not.toContain('copiedTimer.current');
    expect(unmount).toContain('clearTimeout(copiedTimer.current)');
    expect(unmount).toContain('clearTimeout(embedCopiedTimer.current)');
  });
});
