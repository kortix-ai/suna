import { describe, expect, test } from 'bun:test';
import { approvalPreviewReviewable } from './args-preview';
import { type ApprovalEnricherContext, enricherKey, resolveApprovalPreview } from './approval-enrichers';
import type { GatewayConnector } from './gateway';

const GMAIL: GatewayConnector = {
  connectorId: 'conn-gmail',
  slug: 'mail',
  provider: 'composio',
  baseUrl: null,
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const ctx = {} as ApprovalEnricherContext;
const draft = {
  to: ['buyer@example.test'],
  subject: 'Quote',
  body: 'Hello',
  attachments: ['quote.pdf'],
  access_token: 'tok-synthetic',
};

describe('enricherKey', () => {
  test('names the provider action, not the user-chosen slug', () => {
    expect(enricherKey(GMAIL, { kind: 'composio', toolkit: 'gmail', toolSlug: 'GMAIL_SEND_DRAFT' }, 'send_draft')).toBe(
      'composio:GMAIL_SEND_DRAFT',
    );
    expect(
      enricherKey({ ...GMAIL, provider: 'mcp', baseUrl: 'https://mail.example.test/mcp' }, { kind: 'mcp', tool: 'send_draft' }, 'send_draft'),
    ).toBe('mcp:mail.example.test/send_draft');
    expect(enricherKey({ ...GMAIL, provider: 'openapi' }, { kind: 'http', method: 'POST', path: '/x' }, 'drafts.send')).toBe(
      'openapi:mail.drafts.send',
    );
  });
});

describe('resolveApprovalPreview', () => {
  test('stores a redacted preview and a digest of the un-redacted content', async () => {
    const resolved = await resolveApprovalPreview(async () => draft, ctx);
    expect(resolved).toEqual({
      resolved_preview: { ...draft, access_token: '[redacted]' },
      resolved_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('the digest ignores key order and changes with the content', async () => {
    const digest = async (value: Record<string, unknown>) => {
      const resolved = await resolveApprovalPreview(async () => value, ctx);
      return 'resolved_digest' in resolved ? resolved.resolved_digest : null;
    };
    const reordered = Object.fromEntries(Object.entries(draft).reverse());
    expect(await digest(reordered)).toBe(await digest(draft));
    expect(await digest({ ...draft, to: ['other@example.test'] })).not.toBe(await digest(draft));
    // The redacted field is still bound: a changed secret-shaped value counts.
    expect(await digest({ ...draft, access_token: 'tok-other' })).not.toBe(await digest(draft));
  });

  test('a failed, empty, or slow read is unavailable and never throws', async () => {
    const unavailable = { resolved_error: 'unavailable' } as const;
    expect(await resolveApprovalPreview(async () => { throw new Error('upstream 500'); }, ctx)).toEqual(unavailable);
    expect(await resolveApprovalPreview(async () => null, ctx)).toEqual(unavailable);
    expect(await resolveApprovalPreview(async () => ({}), ctx)).toEqual(unavailable);
    expect(await resolveApprovalPreview(() => new Promise(() => {}), ctx, 5)).toEqual(unavailable);
  });
});

describe('approvalPreviewReviewable', () => {
  test('a non-empty resolved preview is reviewable on its own', () => {
    expect(approvalPreviewReviewable({ resolved_preview: { to: 'a@example.test' } })).toBe(true);
    expect(approvalPreviewReviewable({ resolved_preview: {} })).toBe(false);
  });
});
