import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  AgentMailApiError,
  agentMailProvisioningClientIds,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} from '../channels/agentmail-api';
import type { AgentMailMessageReceivedEvent } from '../channels/email/types';
import { verifyAgentMailSignature } from '../channels/email/verify';
import { config } from '../config';

let dbResults: unknown[][] = [];

function makeChain(): any {
  const chain: any = {};
  for (const m of [
    'from',
    'innerJoin',
    'where',
    'limit',
    'set',
    'values',
    'onConflictDoNothing',
    'returning',
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  },
  hasDatabase: () => true,
}));

let continueCalls: Array<{
  sessionId: string;
  text: string;
  opencodeEnv?: Record<string, string | null>;
}> = [];
let createCalls: Array<any> = [];

function expectConnectorEmailPrompt(prompt: string) {
  for (const tool of ['connectors', 'discover', 'describe', 'call']) {
    expect(prompt).toContain(`\`${tool}\``);
  }
  expect(prompt).toContain('"connector":"email"');
  expect(prompt).toContain('"action":"reply_message"');
  expect(prompt).toContain('"inbox_id":"inb-1"');
  expect(prompt).toContain('"message_id":"msg-1"');
  expect(prompt).toContain('"text":"<reply>"');
  expect(prompt).toContain('Use `html` instead of `text` only when needed.');
  expect(prompt).not.toContain('call `email.reply_message`');
}

const {
  dispatchAgentMailEvent,
  isAgentMailSenderAllowedForTest,
  resetEmailSessionLifecycleForTest,
  setEmailSenderPolicyLoaderForTest,
  setEmailSessionLifecycleForTest,
} = await import('../channels/email/session');
const { emailWebhookApp } = await import('../channels/email/app');
await import('../channels/email/routes');

const event: AgentMailMessageReceivedEvent = {
  type: 'event',
  event_type: 'message.received',
  event_id: 'evt-1',
  message: {
    inbox_id: 'inb-1',
    thread_id: 'thr-1',
    message_id: 'msg-1',
    from: 'Customer <customer@example.com>',
    to: ['agent@example.com'],
    subject: 'Need help',
    text: 'Can you help?',
    extracted_text: 'Can you help?',
    attachments: [],
  },
  thread: {
    inbox_id: 'inb-1',
    thread_id: 'thr-1',
    subject: 'Need help',
    message_count: 1,
  },
};

afterAll(() => {
  resetEmailSessionLifecycleForTest();
  mock.restore();
});

beforeEach(() => {
  dbResults = [];
  continueCalls = [];
  createCalls = [];
  setEmailSessionLifecycleForTest({
    resolveWorkspaceAutomationActor: async () => 'user-1',
    continueSession: async (input) => {
      continueCalls.push({
        sessionId: input.sessionId,
        text: input.text,
        opencodeEnv: input.opencodeEnv,
      });
      return 'delivered';
    },
    createSession: async (input) => {
      createCalls.push(input);
      return {
        status: 'created',
        sessionId: 'sess-1',
        row: { sessionId: 'sess-1' } as any,
      };
    },
  });
});

describe('AgentMail webhook verification', () => {
  test('accepts valid Svix v1 signatures and rejects tampering', () => {
    const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
    const rawBody = JSON.stringify({ ok: true });
    const svixId = 'msg_123';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from('test-signing-key'))
      .update(`${svixId}.${svixTimestamp}.${rawBody}`)
      .digest('base64');

    expect(
      verifyAgentMailSignature({
        rawBody,
        secret,
        svixId,
        svixTimestamp,
        svixSignature: `v1,${sig}`,
      }),
    ).toBe(true);
    expect(
      verifyAgentMailSignature({
        rawBody: `${rawBody} `,
        secret,
        svixId,
        svixTimestamp,
        svixSignature: `v1,${sig}`,
      }),
    ).toBe(false);
  });

  test('webhook route fails closed when signing is missing or invalid', async () => {
    const originalSecret = config.AGENTMAIL_WEBHOOK_SECRET;
    const rawBody = JSON.stringify(event);
    try {
      (config as { AGENTMAIL_WEBHOOK_SECRET: string | undefined }).AGENTMAIL_WEBHOOK_SECRET =
        undefined;
      const missingSecret = await emailWebhookApp.request('/agentmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawBody,
      });
      expect(missingSecret.status).toBe(503);

      (config as { AGENTMAIL_WEBHOOK_SECRET: string | undefined }).AGENTMAIL_WEBHOOK_SECRET =
        `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
      const invalidSignature = await emailWebhookApp.request('/agentmail', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': 'msg_123',
          'svix-timestamp': String(Math.floor(Date.now() / 1000)),
          'svix-signature': 'v1,not-valid',
        },
        body: rawBody,
      });
      expect(invalidSignature.status).toBe(401);

      const standardId = 'msg_standard_123';
      const standardTimestamp = String(Math.floor(Date.now() / 1000));
      const standardSignature = createHmac('sha256', Buffer.from('test-signing-key'))
        .update(`${standardId}.${standardTimestamp}.${rawBody}`)
        .digest('base64');
      const standardHeaders = await emailWebhookApp.request('/agentmail', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': standardId,
          'webhook-timestamp': standardTimestamp,
          'webhook-signature': `v1,${standardSignature}`,
        },
        body: rawBody,
      });
      expect(standardHeaders.status).toBe(200);

      // A malformed unsigned body (missing event_type/inbox_id) must NOT be
      // acked with 200 — that let an unauthenticated caller poison ack/monitoring
      // with `{}` -> 200 ok. Now rejected with 400 before any signature check.
      const malformed = await emailWebhookApp.request('/agentmail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(malformed.status).toBe(400);
    } finally {
      (config as { AGENTMAIL_WEBHOOK_SECRET: string | undefined }).AGENTMAIL_WEBHOOK_SECRET =
        originalSecret;
    }
  });
});

describe('AgentMail credential resolution', () => {
  test('supports both project BYO keys and server-managed fallback keys', () => {
    const original = config.AGENTMAIL_API_KEY;
    try {
      (config as { AGENTMAIL_API_KEY: string | undefined }).AGENTMAIL_API_KEY =
        'server-managed-key';
      expect(resolveAgentMailApiKey('project-byo-key')).toBe('project-byo-key');
      expect(resolveAgentMailApiKey(null)).toBe('server-managed-key');
      expect(resolveAgentMailApiKey(undefined)).toBe('server-managed-key');

      (config as { AGENTMAIL_API_KEY: string | undefined }).AGENTMAIL_API_KEY = undefined;
      expect(resolveAgentMailApiKey(null)).toBeNull();
    } finally {
      (config as { AGENTMAIL_API_KEY: string | undefined }).AGENTMAIL_API_KEY = original;
    }
  });
});

describe('AgentMail provisioning idempotency', () => {
  test('scopes inbox and webhook client ids to the project connection tuple', () => {
    const alpha = agentMailProvisioningClientIds('project-1', 'veyris_email_alpha');
    const alphaRetry = agentMailProvisioningClientIds('project-1', 'VEYRIS_EMAIL_ALPHA');
    const beta = agentMailProvisioningClientIds('project-1', 'veyris_email_beta');
    const otherWorkspace = agentMailProvisioningClientIds('project-2', 'veyris_email_alpha');

    expect(alphaRetry).toEqual(alpha);
    expect(beta.inbox).not.toBe(alpha.inbox);
    expect(beta.webhook).not.toBe(alpha.webhook);
    expect(otherWorkspace.inbox).not.toBe(alpha.inbox);
    expect(alpha.inbox).toMatch(/^kortix-inbox-[a-f0-9]{40}$/);
    expect(alpha.webhook).toMatch(/^kortix-webhook-[a-f0-9]{40}$/);
  });
});

describe('AgentMail webhook provisioning', () => {
  test('subscribes new inbox webhooks to normal and unauthenticated inbound mail', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: any = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ webhook_id: 'wh-1', secret: 'whsec_test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await createAgentMailWebhook({
        apiKey: 'am_test',
        inboxId: 'inb-1',
        url: 'https://api.kortix.test/v1/webhooks/email/agentmail',
        clientId: 'kortix-email-proj-1',
      });
      expect(requestBody.event_types).toEqual([
        'message.received',
        'message.received.unauthenticated',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('AgentMail provider errors', () => {
  test('preserves upstream status and detects inbox quota failures', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: 'Maximum number of inboxes reached for this workspace',
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      )) as unknown as typeof fetch;
    try {
      try {
        await createAgentMailInbox({
          apiKey: 'am_test',
          username: 'support',
          displayName: 'Support',
          clientId: 'kortix-project-proj-1',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentMailApiError);
        expect((err as AgentMailApiError).status).toBe(403);
        expect(isAgentMailInboxLimitError(err)).toBe(true);
        return;
      }
      throw new Error('Expected AgentMail inbox create to fail');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('dispatchAgentMailEvent', () => {
  test('first message creates one project-visible session bound to the email thread', async () => {
    dbResults = [
      [{ eventId: 'email:event:evt-1' }],
      [{ workspaceId: 'proj-1' }],
      [],
      [{ eventId: 'email:msg:inb-1:msg-1' }],
      [],
      [
        {
          workspaceId: 'proj-1',
          accountId: 'acc-1',
          defaultBranch: 'main',
          name: 'Support',
        },
      ],
      [{ agentName: 'veyris', opencodeModel: null }],
      [{ eventId: 'email:threadcreate:inb-1:thr-1' }],
      [
        {
          connectionId: 'connection-email-1',
          metadata: { inbox_id: 'inb-1' },
          status: 'active',
        },
      ],
    ];

    await dispatchAgentMailEvent(event);

    expect(continueCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].source).toBe('email');
    expect(createCalls[0].postCreate).toEqual([
      {
        type: 'bind_chat_thread',
        platform: 'email',
        platformWorkspaceId: 'inb-1',
        threadId: 'thr-1',
      },
      expect.objectContaining({
        type: 'deliver_prompt',
        source: 'email',
        userId: 'user-1',
      }),
    ]);
    expect(createCalls[0].postCreate[1].text).toContain('Need help');
    expectConnectorEmailPrompt(createCalls[0].postCreate[1].text);
    expect(createCalls[0].extraEnvVars.KORTIX_EMAIL_INBOX_ID).toBe('inb-1');
    expect(createCalls[0].extraEnvVars.KORTIX_CONNECTORS_MCP_ENABLED).toBe('1');
    expect(createCalls[0].body.connector_bindings).toEqual({
      email: { connection_id: 'connection-email-1' },
    });
    expect(createCalls[0].body.agent_name).toBe('veyris');
    expect(createCalls[0].body.initial_prompt).toBeUndefined();
  });

  test("accepts AgentMail's unwrapped message.received payload without top-level thread metadata", async () => {
    const { type: _type, thread: _thread, ...unwrappedEvent } = event;
    const actualAgentMailPayload: AgentMailMessageReceivedEvent = {
      ...unwrappedEvent,
      event_id: 'evt-unwrapped',
      message: {
        ...event.message,
        thread_id: 'thr-unwrapped',
        message_id: 'msg-unwrapped',
        subject: 'Actual AgentMail payload',
      },
    };
    dbResults = [
      [{ eventId: 'email:event:evt-unwrapped' }],
      [{ workspaceId: 'proj-1' }],
      [],
      [{ eventId: 'email:msg:inb-1:msg-unwrapped' }],
      [],
      [
        {
          workspaceId: 'proj-1',
          accountId: 'acc-1',
          defaultBranch: 'main',
          name: 'Support',
        },
      ],
      [],
      [{ eventId: 'email:threadcreate:inb-1:thr-unwrapped' }],
      [
        {
          connectionId: 'connection-email-1',
          metadata: { inbox_id: 'inb-1' },
          status: 'active',
        },
      ],
    ];

    await dispatchAgentMailEvent(actualAgentMailPayload);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].metadata.email.subject).toBe('Actual AgentMail payload');
    expect(createCalls[0].postCreate[1].text).toContain('Thread ID:  thr-unwrapped');
  });

  test('routes unauthenticated inbound mail through the same sender policy and session path', async () => {
    const unauthenticatedEvent: AgentMailMessageReceivedEvent = {
      ...event,
      event_type: 'message.received.unauthenticated',
      event_id: 'evt-unauth',
      message: { ...event.message, message_id: 'msg-unauth' },
    };
    dbResults = [
      [{ eventId: 'email:event:evt-unauth' }],
      [{ workspaceId: 'proj-1' }],
      [],
      [{ eventId: 'email:msg:inb-1:msg-unauth' }],
      [{ sessionId: 'sess-1' }],
      [
        {
          connectionId: 'connection-email-1',
          metadata: { inbox_id: 'inb-1' },
          status: 'active',
        },
      ],
      [{ accountId: 'acc-1', connectorId: 'conn-email' }],
      [{ accountId: 'acc-1' }],
      [],
      [{ connectionId: 'connection-email-1' }],
    ];

    await dispatchAgentMailEvent(unauthenticatedEvent);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe('sess-1');
    expect(continueCalls[0].opencodeEnv).toEqual({ KORTIX_CONNECTORS_MCP_ENABLED: '1' });
  });

  test('known thread routes a new email into the existing session', async () => {
    dbResults = [
      [{ eventId: 'email:event:evt-1' }],
      [{ workspaceId: 'proj-1' }],
      [],
      [{ eventId: 'email:msg:inb-1:msg-1' }],
      [{ sessionId: 'sess-1' }],
      [
        {
          connectionId: 'connection-email-1',
          metadata: { inbox_id: 'inb-1' },
          status: 'active',
        },
      ],
      [{ accountId: 'acc-1', connectorId: 'conn-email' }],
      [{ accountId: 'acc-1' }],
      [],
      [{ connectionId: 'connection-email-1' }],
    ];

    await dispatchAgentMailEvent(event);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe('sess-1');
    expect(continueCalls[0].opencodeEnv).toEqual({ KORTIX_CONNECTORS_MCP_ENABLED: '1' });
    expect(continueCalls[0].text).toContain('Customer <customer@example.com>');
    expectConnectorEmailPrompt(continueCalls[0].text);
  });

  test('a rejected sender never claims the message or creates or continues a session', async () => {
    setEmailSenderPolicyLoaderForTest(async () => ({
      mode: 'restricted',
      allowedEmails: ['approved@example.com'],
      allowedDomains: [],
      allowedRegex: null,
    }));
    dbResults = [
      [{ eventId: 'email:event:evt-1' }],
      [{ workspaceId: 'proj-1' }],
      // If dispatch moves past policy enforcement, these sentinels would let
      // it claim the inbound message and create a new thread/session.
      [],
      [{ eventId: 'email:msg:inb-1:msg-1' }],
      [],
    ];

    await dispatchAgentMailEvent(event);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(0);
    expect(dbResults).toHaveLength(3);
  });

  test('sender allow policy supports exact emails, domains, and regex', () => {
    const policy = {
      mode: 'restricted' as const,
      allowedEmails: ['customer@example.com'],
      allowedDomains: ['kortix.com'],
      allowedRegex: '^vip-[0-9]+@example\\.org$',
    };

    expect(isAgentMailSenderAllowedForTest(event, policy)).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: {
            ...event.message,
            from: 'Teammate <person@ops.kortix.com>',
          },
        },
        policy,
      ),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: { ...event.message, from: 'vip-12@example.org' },
        },
        policy,
      ),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: { ...event.message, from: 'Other <other@external.test>' },
        },
        policy,
      ),
    ).toBe(false);
  });

  test('sender regex runtime stays linear for ambiguous repetition and fails closed on unsupported syntax', () => {
    const adversarialSender = `${'a'.repeat(50_000)}!@example.com`;
    const allowed = (allowedRegex: string) =>
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: {
            ...event.message,
            from: adversarialSender,
            from_: undefined,
          },
        },
        {
          mode: 'restricted',
          allowedEmails: [],
          allowedDomains: [],
          allowedRegex,
        },
      );
    const startedAt = performance.now();

    expect(allowed('^(a{1,3})+@example\\.com$')).toBe(false);
    expect(allowed('^(a|aa)+@example\\.com$')).toBe(false);
    expect(allowed('^(?=a)a+@example\\.com$')).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('sender allow policy rejects ambiguous or attacker-controlled From values', () => {
    const policy = {
      mode: 'restricted' as const,
      allowedEmails: ['customer@example.com'],
      allowedDomains: [],
      allowedRegex: null,
    };
    const allowed = (from: AgentMailMessageReceivedEvent['message']['from']) =>
      isAgentMailSenderAllowedForTest(
        { ...event, message: { ...event.message, from, from_: undefined } },
        policy,
      );

    expect(allowed('Customer <customer@example.com>')).toBe(true);
    expect(allowed('customer@example.com')).toBe(true);
    expect(allowed('customer@example.com <attacker@evil.test>')).toBe(false);
    expect(allowed('Attacker <attacker@evil.test>, customer@example.com')).toBe(false);
    expect(allowed('Customer <customer@example.com> trailing')).toBe(false);
    expect(allowed('Customer customer@example.com')).toBe(false);
  });

  test('sender allow policy requires exactly one structured From mailbox', () => {
    const policy = {
      mode: 'restricted' as const,
      allowedEmails: ['customer@example.com'],
      allowedDomains: [],
      allowedRegex: null,
    };
    const allowed = (from_: AgentMailMessageReceivedEvent['message']['from_']) =>
      isAgentMailSenderAllowedForTest(
        { ...event, message: { ...event.message, from: undefined, from_ } },
        policy,
      );

    expect(allowed([{ email: 'customer@example.com', name: 'Customer' }])).toBe(true);
    expect(allowed([{ address: 'customer@example.com' }])).toBe(true);
    expect(
      allowed([
        {
          email: ' Customer@Example.COM ',
          address: 'customer@example.com',
        },
      ]),
    ).toBe(true);
    expect(allowed([{ email: '', address: 'customer@example.com' }])).toBe(true);
    expect(allowed([{ email: 'customer@example.com', address: 'attacker@evil.test' }])).toBe(false);
    expect(allowed([{ email: 'not a mailbox', address: 'customer@example.com' }])).toBe(false);
    expect(allowed([{ name: 'customer@example.com' }])).toBe(false);
    expect(allowed(['customer@example.com', 'attacker@evil.test'])).toBe(false);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: {
            ...event.message,
            from: 'customer@example.com',
            from_: 'attacker@evil.test',
          },
        },
        policy,
      ),
    ).toBe(false);
  });
});
