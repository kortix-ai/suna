import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const section = readFileSync(
  fileURLToPath(new URL('./session-public-link-section.tsx', import.meta.url)),
  'utf8',
);
const panel = readFileSync(
  fileURLToPath(new URL('./share-session-panel.tsx', import.meta.url)),
  'utf8',
);

describe('Share panel public link', () => {
  test('sources are the expected modules', () => {
    expect(section).toContain('export function SessionPublicLinkRow');
    expect(panel).toContain('export function ShareSessionPanel');
  });

  test('sits in the Share panel, gated on the same verdict as the access options', () => {
    expect(panel).toContain(
      '{view.canEdit ? (\n        <SessionPublicLinkRow projectId={projectId} sessionId={session.session_id} />',
    );
    // After the options, before the footer.
    expect(panel.indexOf('role="radiogroup"')).toBeLessThan(panel.indexOf('<SessionPublicLinkRow'));
    expect(panel.lastIndexOf('<SessionPublicLinkRow')).toBeLessThan(
      panel.lastIndexOf('<ShareFooter'),
    );
  });

  test('creates a transcript share only through the confirmed mint path', () => {
    expect(section).toContain('{ transcript: true }');
    expect(section).toContain('usePublicShareLink(');
    // Create only opens the confirm; the confirm's button mints.
    expect(section).toContain('onClick={link.copyLink}');
    expect(section).toContain('onConfirm={link.confirmation.onConfirm}');
  });

  test('shows the live link from the SDK helper, and revokes only after a confirm', () => {
    expect(section).toContain('findActiveTranscriptShare(shares)');
    const confirm = section.slice(section.indexOf('if (confirmRevoke && active)'));
    expect(confirm.slice(0, confirm.indexOf('return (\n    <Row'))).toContain(
      'revoke(active.share_id)',
    );
    // The menu item itself only opens the confirm.
    expect(section).toContain('onSelect={() => setConfirmRevoke(true)}');
    expect(section.match(/revoke\(/g)).toHaveLength(1);
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
