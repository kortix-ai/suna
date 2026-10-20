import { describe, expect, test } from 'bun:test';
import { approvalPreviewReviewable } from './args-preview';
import {
  APPROVAL_ENRICHERS,
  type ApprovalEnricherContext,
  enricherKey,
  resolveApprovalPreview,
} from './approval-enrichers';
import type { GatewayConnector, GatewayDeps } from './gateway';

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

/**
 * Composio Gmail results shaped like the live tool output (2026-10-20), with
 * synthetic values only. `GMAIL_LIST_DRAFTS {verbose:true}` →
 * `drafts[{id, message{payload{headers[{name,value}]}, messageText, attachmentList[{filename}]}}]`.
 */
function gmailCtx(
  results: Record<string, unknown>,
  args: Record<string, unknown>,
): { ctx: ApprovalEnricherContext; calls: Array<{ toolSlug: string; args: Record<string, unknown> }> } {
  const calls: Array<{ toolSlug: string; args: Record<string, unknown> }> = [];
  const deps = {
    executeComposio: async (input: { toolSlug: string; args: Record<string, unknown> }) => {
      calls.push({ toolSlug: input.toolSlug, args: input.args });
      const result = results[input.toolSlug];
      return result ? { ok: true, status: 200, data: { provider: 'composio', result } } : { ok: false, status: 502, data: null };
    },
  } as unknown as GatewayDeps;
  const ctx = {
    deps,
    input: { projectId: 'p', accountId: 'a', subject: { userId: 'u', groupIds: [] }, connectorSlug: 'mail', actionPath: 'send_draft' },
    connector: { ...GMAIL, connectionId: 'conn-1', connectionMetadata: { connected_account_id: 'ca-1', session_id: 'trs-1' } },
    binding: { kind: 'composio', toolkit: 'gmail', toolSlug: 'GMAIL_SEND_DRAFT' },
    args,
  } as ApprovalEnricherContext;
  return { ctx, calls };
}

const header = (name: string, value: string) => ({ name, value });
const draftRow = (id: string, headers: Array<{ name: string; value: string }>, extra: Record<string, unknown> = {}) => ({
  id,
  message: {
    messageId: `m-${id}`,
    messageTimestamp: '2026-10-20T10:00:00Z',
    messageText: 'Hello from the synthetic draft.',
    attachmentList: [{ attachmentId: 'volatile-attachment-id', filename: 'quote.pdf', mimeType: 'application/pdf' }],
    payload: {
      headers: [header('Date', 'Mon, 20 Oct 2026 10:00:00 +0000'), header('Message-Id', '<volatile@example.test>'), ...headers],
    },
    subject: null,
    to: null,
    ...extra,
  },
});
const PROFILE = { emailAddress: 'ops@example.test', historyId: '1', messagesTotal: 3, threadsTotal: 2 };

describe('gmail enrichers', () => {
  const sendDraft = APPROVAL_ENRICHERS['composio:GMAIL_SEND_DRAFT'];
  const sendEmail = APPROVAL_ENRICHERS['composio:GMAIL_SEND_EMAIL'];

  test('send_draft maps the matching draft to from/to/cc/bcc/subject/body/attachments', async () => {
    const { ctx, calls } = gmailCtx(
      {
        GMAIL_LIST_DRAFTS: {
          drafts: [
            draftRow('r-other', [header('to', 'nobody@example.test')]),
            draftRow('r-123', [
              header('to', 'buyer@example.test'),
              header('Cc', 'team@example.test'),
              header('BCC', 'audit@example.test'),
              header('subject', 'Quote'),
              header('From', 'Ops <ops@example.test>'),
            ]),
          ],
          next_page_token: null,
        },
      },
      { draft_id: 'r-123' },
    );
    expect(await sendDraft(ctx)).toEqual({
      from: 'Ops <ops@example.test>',
      to: 'buyer@example.test',
      cc: 'team@example.test',
      bcc: 'audit@example.test',
      subject: 'Quote',
      body: 'Hello from the synthetic draft.',
      attachments: ['quote.pdf'],
    });
    // One read-only list call with the page size; no profile read when From is present.
    expect(calls).toEqual([{ toolSlug: 'GMAIL_LIST_DRAFTS', args: { verbose: true, max_results: 500 } }]);
  });

  test('send_draft falls back to the profile address and reads absent headers as empty', async () => {
    const { ctx } = gmailCtx(
      { GMAIL_LIST_DRAFTS: { drafts: [draftRow('r-1', [header('to', 'buyer@example.test')], { attachmentList: [] })] }, GMAIL_GET_PROFILE: PROFILE },
      { draft_id: 'r-1' },
    );
    expect(await sendDraft(ctx)).toEqual({
      from: 'ops@example.test',
      to: 'buyer@example.test',
      cc: '',
      bcc: '',
      subject: '',
      body: 'Hello from the synthetic draft.',
      attachments: [],
    });
  });

  test('send_draft content is deterministic: volatile ids and dates stay out of the digest', async () => {
    const digest = async (row: ReturnType<typeof draftRow>) => {
      const { ctx } = gmailCtx({ GMAIL_LIST_DRAFTS: { drafts: [row] } }, { draft_id: 'r-1' });
      const resolved = await resolveApprovalPreview(sendDraft, ctx);
      return 'resolved_digest' in resolved ? resolved.resolved_digest : null;
    };
    const base = draftRow('r-1', [header('From', 'ops@example.test'), header('to', 'buyer@example.test')]);
    const later = draftRow('r-1', [header('From', 'ops@example.test'), header('to', 'buyer@example.test')], {
      messageTimestamp: '2026-10-21T10:00:00Z',
      attachmentList: [{ attachmentId: 'another-volatile-id', filename: 'quote.pdf' }],
    });
    expect(await digest(base)).not.toBeNull();
    expect(await digest(later)).toBe(await digest(base));
  });

  test('send_draft is unavailable when the draft is missing, the id is absent, or the list fails', async () => {
    const unavailable = { resolved_error: 'unavailable' };
    const missing = gmailCtx({ GMAIL_LIST_DRAFTS: { drafts: [draftRow('r-other', [])] } }, { draft_id: 'r-1' });
    expect(await resolveApprovalPreview(sendDraft, missing.ctx)).toEqual(unavailable);
    const noId = gmailCtx({ GMAIL_LIST_DRAFTS: { drafts: [] } }, {});
    expect(await resolveApprovalPreview(sendDraft, noId.ctx)).toEqual(unavailable);
    expect(noId.calls).toEqual([]);
    const failed = gmailCtx({}, { draft_id: 'r-1' });
    expect(await resolveApprovalPreview(sendDraft, failed.ctx)).toEqual(unavailable);
  });

  test('send_email reads only the sender from the profile', async () => {
    const { ctx, calls } = gmailCtx({ GMAIL_GET_PROFILE: PROFILE }, { to: 'buyer@example.test', subject: 'Hi', body: 'x' });
    expect(await sendEmail(ctx)).toEqual({ from: 'ops@example.test' });
    expect(calls).toEqual([{ toolSlug: 'GMAIL_GET_PROFILE', args: {} }]);
    expect(await resolveApprovalPreview(sendEmail, gmailCtx({}, {}).ctx)).toEqual({ resolved_error: 'unavailable' });
  });
});
