import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyAgentMailSignature } from "../channels/email/verify";
import type { AgentMailMessageReceivedEvent } from "../channels/email/types";

let dbResults: unknown[][] = [];
const channelConfig: Record<string, unknown> = {};

function makeChain(): any {
  const chain: any = {};
  for (const m of [
    "from",
    "where",
    "limit",
    "set",
    "values",
    "onConflictDoNothing",
    "returning",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}

const fakeDb = {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
};

mock.module("../shared/db", () => ({
  db: fakeDb,
  hasDatabase: () => true,
}));

mock.module("../shared/effect", () => ({
  sharedConfig: channelConfig,
  sharedDb: fakeDb,
  sharedSupabase: {},
  sharedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  sharedSleep: async () => {},
  runSharedTimeout: () => ({}) as never,
  runSharedInterval: () => ({}) as never,
  stopSharedTimer: () => {},
}));

const {
  AgentMailApiError,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} = await import("../channels/agentmail-api");

let continueCalls: Array<{ sessionId: string; text: string }> = [];
let createCalls: Array<any> = [];

const {
  dispatchAgentMailEvent,
  isAgentMailSenderAllowedForTest,
  resetEmailSessionLifecycleForTest,
  setEmailSessionLifecycleForTest,
} = await import("../channels/email/session");

const event: AgentMailMessageReceivedEvent = {
  type: "event",
  event_type: "message.received",
  event_id: "evt-1",
  message: {
    inbox_id: "inb-1",
    thread_id: "thr-1",
    message_id: "msg-1",
    from: "Customer <customer@example.com>",
    to: ["agent@example.com"],
    subject: "Need help",
    text: "Can you help?",
    extracted_text: "Can you help?",
    attachments: [],
  },
  thread: {
    inbox_id: "inb-1",
    thread_id: "thr-1",
    subject: "Need help",
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
    resolveProjectAutomationActor: async () => "user-1",
    continueSession: async (input) => {
      continueCalls.push({ sessionId: input.sessionId, text: input.text });
      return "delivered";
    },
    createSession: async (input) => {
      createCalls.push(input);
      return {
        status: "created",
        sessionId: "sess-1",
        row: { sessionId: "sess-1" } as any,
      };
    },
  });
});

describe("AgentMail webhook verification", () => {
  test("accepts valid Svix v1 signatures and rejects tampering", () => {
    const secret = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;
    const rawBody = JSON.stringify({ ok: true });
    const svixId = "msg_123";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from("test-signing-key"))
      .update(`${svixId}.${svixTimestamp}.${rawBody}`)
      .digest("base64");

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
});

describe("AgentMail credential resolution", () => {
  test("supports both project BYO keys and server-managed fallback keys", () => {
    const original = channelConfig.AGENTMAIL_API_KEY;
    try {
      channelConfig.AGENTMAIL_API_KEY = "server-managed-key";
      expect(resolveAgentMailApiKey("project-byo-key")).toBe("project-byo-key");
      expect(resolveAgentMailApiKey(null)).toBe("server-managed-key");
      expect(resolveAgentMailApiKey(undefined)).toBe("server-managed-key");

      channelConfig.AGENTMAIL_API_KEY = undefined;
      expect(resolveAgentMailApiKey(null)).toBeNull();
    } finally {
      channelConfig.AGENTMAIL_API_KEY = original;
    }
  });
});

describe("AgentMail webhook provisioning", () => {
  test("subscribes new inbox webhooks to normal and unauthenticated inbound mail", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: any = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ webhook_id: "wh-1", secret: "whsec_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await createAgentMailWebhook({
        apiKey: "am_test",
        inboxId: "inb-1",
        url: "https://api.kortix.test/v1/webhooks/email/agentmail",
        clientId: "kortix-email-proj-1",
      });
      expect(requestBody.event_types).toEqual([
        "message.received",
        "message.received.unauthenticated",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AgentMail provider errors", () => {
  test("preserves upstream status and detects inbox quota failures", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: "Maximum number of inboxes reached for this workspace",
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;
    try {
      try {
        await createAgentMailInbox({
          apiKey: "am_test",
          username: "support",
          displayName: "Support",
          clientId: "kortix-project-proj-1",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentMailApiError);
        expect((err as InstanceType<typeof AgentMailApiError>).status).toBe(403);
        expect(isAgentMailInboxLimitError(err)).toBe(true);
        return;
      }
      throw new Error("Expected AgentMail inbox create to fail");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("dispatchAgentMailEvent", () => {
  test("first message creates one project-visible session bound to the email thread", async () => {
    dbResults = [
      [{ eventId: "email:event:evt-1" }],
      [{ projectId: "proj-1" }],
      [],
      [{ eventId: "email:msg:inb-1:msg-1" }],
      [],
      [
        {
          projectId: "proj-1",
          accountId: "acc-1",
          defaultBranch: "main",
          name: "Support",
        },
      ],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await dispatchAgentMailEvent(event);

    expect(continueCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].source).toBe("email");
    expect(createCalls[0].postCreate).toEqual([
      {
        type: "bind_chat_thread",
        platform: "email",
        workspaceId: "inb-1",
        threadId: "thr-1",
      },
      expect.objectContaining({
        type: "deliver_prompt",
        source: "email",
        userId: "user-1",
      }),
    ]);
    expect(createCalls[0].postCreate[1].text).toContain("Need help");
    expect(createCalls[0].extraEnvVars.KORTIX_EMAIL_INBOX_ID).toBe("inb-1");
    expect(createCalls[0].body.initial_prompt).toBeUndefined();
  });

  test("accepts AgentMail's unwrapped message.received payload without top-level thread metadata", async () => {
    const { type: _type, thread: _thread, ...unwrappedEvent } = event;
    const actualAgentMailPayload: AgentMailMessageReceivedEvent = {
      ...unwrappedEvent,
      event_id: "evt-unwrapped",
      message: {
        ...event.message,
        thread_id: "thr-unwrapped",
        message_id: "msg-unwrapped",
        subject: "Actual AgentMail payload",
      },
    };
    dbResults = [
      [{ eventId: "email:event:evt-unwrapped" }],
      [{ projectId: "proj-1" }],
      [],
      [{ eventId: "email:msg:inb-1:msg-unwrapped" }],
      [],
      [
        {
          projectId: "proj-1",
          accountId: "acc-1",
          defaultBranch: "main",
          name: "Support",
        },
      ],
      [{ eventId: "email:threadcreate:inb-1:thr-unwrapped" }],
    ];

    await dispatchAgentMailEvent(actualAgentMailPayload);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].metadata.email.subject).toBe("Actual AgentMail payload");
    expect(createCalls[0].postCreate[1].text).toContain("Thread ID:  thr-unwrapped");
  });

  test("routes unauthenticated inbound mail through the same sender policy and session path", async () => {
    const unauthenticatedEvent: AgentMailMessageReceivedEvent = {
      ...event,
      event_type: "message.received.unauthenticated",
      event_id: "evt-unauth",
      message: { ...event.message, message_id: "msg-unauth" },
    };
    dbResults = [
      [{ eventId: "email:event:evt-unauth" }],
      [{ projectId: "proj-1" }],
      [],
      [{ eventId: "email:msg:inb-1:msg-unauth" }],
      [{ sessionId: "sess-1" }],
    ];

    await dispatchAgentMailEvent(unauthenticatedEvent);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-1");
  });

  test("known thread routes a new email into the existing session", async () => {
    dbResults = [
      [{ eventId: "email:event:evt-1" }],
      [{ projectId: "proj-1" }],
      [],
      [{ eventId: "email:msg:inb-1:msg-1" }],
      [{ sessionId: "sess-1" }],
    ];

    await dispatchAgentMailEvent(event);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-1");
    expect(continueCalls[0].text).toContain("Customer <customer@example.com>");
  });

  test("sender allow policy supports exact emails, domains, and regex", () => {
    const policy = {
      mode: "restricted" as const,
      allowedEmails: ["customer@example.com"],
      allowedDomains: ["kortix.com"],
      allowedRegex: "^vip-[0-9]+@example\\.org$",
    };

    expect(isAgentMailSenderAllowedForTest(event, policy)).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: {
            ...event.message,
            from: "Teammate <person@ops.kortix.com>",
          },
        },
        policy,
      ),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: { ...event.message, from: "vip-12@example.org" },
        },
        policy,
      ),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowedForTest(
        {
          ...event,
          message: { ...event.message, from: "Other <other@external.test>" },
        },
        policy,
      ),
    ).toBe(false);
  });
});
