import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ResendEmailApiError,
  createResendInbox,
  ensureResendInboxWebhook,
  resolveEmailApiKey,
  verifyResendDomain,
} from "../channels/resend-email-api";
import type { ResendInboxEmailReceivedEvent } from "../channels/email/types";
import { verifyEmailWebhookSignature } from "../channels/email/verify";
import { config } from "../config";

let dbResults: unknown[][] = [];

function makeChain(): any {
  const chain: any = {};
  for (const m of [
    "from",
    "innerJoin",
    "where",
    "limit",
    "set",
    "values",
    "onConflictDoNothing",
    "onConflictDoUpdate",
    "returning",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}

mock.module("../shared/db", () => ({
  db: {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  },
  hasDatabase: () => true,
}));

// The inbox account (its webhook signing secret, own key, owner) has its own
// tests; here it is fixed so each DB queue below is only the dispatch path.
let inboxWebhookSecret: string | null = null;
let inboxOwner: { ownerType: "project" | "member"; ownerId: string | null } = {
  ownerType: "project",
  ownerId: null,
};
const realInstallStore = await import("../channels/install-store");
mock.module("../channels/install-store", () => ({
  ...realInstallStore,
  emailWebhookSecretForInbox: async () => inboxWebhookSecret,
  emailOwnKeyForInbox: async () => null,
  loadEmailInboxAccountForInbox: async (
    _projectId: string,
    inboxId: string,
  ) => ({
    connectionId: "connection-email-1",
    connectorId: "conn-email",
    projectId: "proj-1",
    inboxId,
    email: "agent@example.com",
    displayName: null,
    label: "agent@example.com",
    isDefault: true,
    managed: true,
    createdByKortix: true,
    senderPolicy: {
      mode: "allow_all",
      allowedEmails: [],
      allowedDomains: [],
      allowedRegex: null,
    },
    agentName: null,
    webhookId: null,
    createdAt: new Date().toISOString(),
    ...inboxOwner,
  }),
}));

let continueCalls: Array<{
  sessionId: string;
  text: string;
  idempotencyKey: string;
  projectId?: string | null;
}> = [];
let createCalls: Array<any> = [];
let deliverOutcome: "delivered" | "no-session" = "delivered";

// The email tools go through the `kortix connectors` CLI, which every harness's
// shell has. OpenCode alone has the MCP face, so an MCP-only prompt left a pi
// session unable to read or answer the thread (W1 B8).
function expectConnectorEmailPrompt(prompt: string) {
  expect(prompt).toContain(
    `kortix connectors call email.get_thread '{"thread_id":"thr-1"}'`,
  );
  expect(prompt).toContain(
    `kortix connectors call email.reply_message '{"thread_id":"thr-1","message_id":"eml-1","text":"<reply>"}'`,
  );
  expect(prompt).toContain("kortix connectors call email.send_message");
  expect(prompt).toContain("kortix connectors show email.<action>");
  expect(prompt).toContain("Use `html` instead of `text` only when needed.");
  expect(prompt).not.toContain("MCP");
  expect(prompt).not.toContain("AgentMail");
}

const {
  dispatchResendEmailEvent,
  isEmailSenderAllowed,
  resetEmailChannelForTest,
  setEmailSenderPolicyLoaderForTest,
  setThreadEmailLoaderForTest,
  stripHtml,
} = await import("../channels/email/session");
const { resetChannelLifecycleForTest, setChannelLifecycleForTest } =
  await import("../channels/core/conversation");
const { emailWebhookApp } = await import("../channels/email/app");
(await import("../channels/email/routes")).registerEmailWebhookRoutes();

const event: ResendInboxEmailReceivedEvent = {
  type: "inbox.email.received",
  created_at: "2026-10-24T10:00:00.000Z",
  data: {
    inbox_id: "inb-1",
    thread_id: "thr-1",
    email_id: "eml-1",
    from: "Customer <customer@example.com>",
    to: ["agent@example.com"],
    subject: "Need help",
  },
};

const ALLOW_ALL = {
  mode: "allow_all" as const,
  allowedEmails: [],
  allowedDomains: [],
  allowedRegex: null,
};
let threadEmailReads: Array<{
  inboxId: string;
  threadId: string;
  emailId: string;
}> = [];

afterAll(() => {
  resetEmailChannelForTest();
  resetChannelLifecycleForTest();
  mock.restore();
});

beforeEach(() => {
  dbResults = [];
  continueCalls = [];
  createCalls = [];
  deliverOutcome = "delivered";
  threadEmailReads = [];
  inboxWebhookSecret = null;
  inboxOwner = { ownerType: "project", ownerId: null };
  (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY =
    "re_managed_test";
  setEmailSenderPolicyLoaderForTest(async () => ALLOW_ALL);
  setThreadEmailLoaderForTest(async (input) => {
    threadEmailReads.push({
      inboxId: input.inboxId,
      threadId: input.threadId,
      emailId: input.emailId,
    });
    return {
      id: input.emailId,
      direction: "inbound",
      from: "Customer <customer@example.com>",
      to: ["agent@example.com"],
      subject: "Need help",
      text: "Can you help?",
      html: "<p>Can you help?</p>",
      attachments: [{ id: "att-1", filename: "invoice.pdf", size: 1200 }],
    };
  });
  setChannelLifecycleForTest({
    // A real read would take a result off the positional DB queue.
    createCommandStatus: async () => null,
    resolveProjectAutomationActor: async () => "user-1",
    deliverThroughQueue: async (input) => {
      continueCalls.push({
        sessionId: input.sessionId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
      });
      return deliverOutcome;
    },
    createSession: async (input) => {
      createCalls.push(input);
      return {
        status: "created",
        sessionId: "sess-1",
        row: { sessionId: "sess-1" } as any,
      };
    },
    sleep: async () => {},
  });
});

function signed(rawBody: string, id = "msg_123") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from("test-signing-key"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

const CHANNEL_ON = { metadata: { experimental: { email_channel: true } } };

describe("Resend webhook verification", () => {
  test("accepts a valid Svix v1 signature and rejects tampering", () => {
    const secret = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;
    const rawBody = JSON.stringify(event);
    const headers = signed(rawBody);
    const input = {
      rawBody,
      secret,
      svixId: headers["svix-id"],
      svixTimestamp: headers["svix-timestamp"],
      svixSignature: headers["svix-signature"],
    };
    expect(verifyEmailWebhookSignature(input)).toBe(true);
    expect(
      verifyEmailWebhookSignature({
        ...input,
        rawBody: rawBody.replace("Need", "Owe"),
      }),
    ).toBe(false);
    expect(
      verifyEmailWebhookSignature({ ...input, secret: "whsec_b3RoZXI=" }),
    ).toBe(false);
  });

  test("route: malformed → 400, unknown inbox or channel off → ignored 200, bad signature → 401, signed → 200", async () => {
    const rawBody = JSON.stringify(event);
    // A bad signature makes the route ask Resend for the current webhook
    // secret once. No test reaches the network: Resend answers 503 here, and
    // the request still ends at 401.
    const realFetch = globalThis.fetch;
    const resendCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      resendCalls.push(String(url));
      return new Response("{}", { status: 503 });
    }) as typeof fetch;
    try {
      // A malformed unsigned body is never acked (pentest NEW-1).
      const malformed = await emailWebhookApp.request("/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(malformed.status).toBe(400);

      // An inbox no project here owns (another environment's): nothing to do.
      dbResults = [[]];
      const unknown = await emailWebhookApp.request("/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      });
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ ok: true, ignored: true });

      inboxWebhookSecret = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;

      // The owning project has the email channel off: ignored, signed or not.
      dbResults = [[{ projectId: "proj-1" }], [{ metadata: {} }]];
      const off = await emailWebhookApp.request("/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signed(rawBody, "msg_off"),
        },
        body: rawBody,
      });
      expect(await off.json()).toEqual({ ok: true, ignored: true });

      dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON]];
      const invalid = await emailWebhookApp.request("/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "x",
          "svix-timestamp": "1",
          "svix-signature": "v1,nope",
        },
        body: rawBody,
      });
      expect(invalid.status).toBe(401);

      // Signed: dispatch runs (here it stops at the event dedupe: already handled).
      dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], []];
      const ok = await emailWebhookApp.request("/resend", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signed(rawBody, "msg_ok"),
        },
        body: rawBody,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(
        resendCalls.every((url) => url.startsWith("https://api.resend.com/")),
      ).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Resend credential resolution", () => {
  test("a project key wins over the managed team key", () => {
    const original = config.RESEND_API_KEY;
    try {
      (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY =
        "re_managed";
      expect(resolveEmailApiKey("re_project")).toBe("re_project");
      expect(resolveEmailApiKey(null)).toBe("re_managed");
      (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY =
        undefined;
      expect(resolveEmailApiKey(null)).toBeNull();
    } finally {
      (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY =
        original;
    }
  });
});

describe("Resend client", () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ method: string; path: string; body: any }> = [];
  function answer(routes: Record<string, { status?: number; body: unknown }>) {
    calls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const hit = routes[`${method} ${path}`] ?? {
        status: 404,
        body: { message: "not found" },
      };
      return new Response(JSON.stringify(hit.body), {
        status: hit.status ?? 200,
      });
    }) as any;
  }
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("creates an inbox at the full address with its sender name", async () => {
    answer({ "POST /inboxes": { body: { object: "inbox", id: "inb-new" } } });
    const inbox = await createResendInbox({
      apiKey: "re_x",
      address: "support@mail.example.com",
      fromName: "Support",
    });
    expect(inbox).toEqual({
      id: "inb-new",
      email_address: "support@mail.example.com",
      from_name: "Support",
    });
    expect(calls[0]?.body).toEqual({
      email_address: "support@mail.example.com",
      from_name: "Support",
    });
  });

  test("keeps Resend status and reason on a refusal (409 taken, 422 not receiving, 403 limit)", async () => {
    for (const status of [409, 422, 403]) {
      answer({
        "POST /inboxes": {
          status,
          body: { name: "refused", message: `refused ${status}` },
        },
      });
      const err = await createResendInbox({
        apiKey: "re_x",
        address: "a@b.com",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ResendEmailApiError);
      expect(err.status).toBe(status);
      expect(err.message).toBe(`refused ${status}`);
    }
  });

  test("reuses the team webhook for this endpoint instead of creating another", async () => {
    answer({
      "GET /webhooks": {
        body: {
          data: [
            {
              id: "wh-1",
              endpoint: "https://api.test/v1/webhooks/email/resend",
              events: ["inbox.email.received"],
            },
          ],
        },
      },
      "GET /webhooks/wh-1": {
        body: {
          id: "wh-1",
          endpoint: "https://api.test/v1/webhooks/email/resend",
          signing_secret: "whsec_existing",
        },
      },
    });
    expect(
      await ensureResendInboxWebhook(
        "re_x",
        "https://api.test/v1/webhooks/email/resend",
      ),
    ).toEqual({
      id: "wh-1",
      signing_secret: "whsec_existing",
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("creates the webhook for inbox.email.received when the endpoint has none", async () => {
    answer({
      "GET /webhooks": {
        body: {
          data: [
            {
              id: "wh-other",
              endpoint: "https://other.test/hook",
              events: ["inbox.email.received"],
            },
          ],
        },
      },
      "POST /webhooks": {
        body: { object: "webhook", id: "wh-2", signing_secret: "whsec_new" },
      },
    });
    expect(
      await ensureResendInboxWebhook(
        "re_x",
        "https://api.test/v1/webhooks/email/resend",
      ),
    ).toEqual({
      id: "wh-2",
      signing_secret: "whsec_new",
    });
    expect(calls.at(-1)?.body).toEqual({
      endpoint: "https://api.test/v1/webhooks/email/resend",
      events: ["inbox.email.received"],
    });
  });

  test("verify switches receiving on for a sending-only domain, then re-checks DNS", async () => {
    answer({
      "GET /domains/dom-1": {
        body: {
          id: "dom-1",
          name: "mail.example.com",
          status: "verified",
          capabilities: { sending: "enabled", receiving: "disabled" },
          records: [],
        },
      },
      "PATCH /domains/dom-1": { body: { id: "dom-1" } },
      "POST /domains/dom-1/verify": { body: { id: "dom-1" } },
    });
    await verifyResendDomain("re_x", "dom-1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /domains/dom-1",
      "PATCH /domains/dom-1",
      "POST /domains/dom-1/verify",
      "GET /domains/dom-1",
    ]);
    expect(calls[1]?.body).toEqual({ capabilities: { receiving: "enabled" } });
  });
});

describe("dispatchResendEmailEvent", () => {
  test("first email reads its body and creates one project-visible session bound to the thread", async () => {
    dbResults = [
      [{ eventId: "email:event:eml-1" }],
      [{ projectId: "proj-1" }],
      [{ eventId: "email:msg:inb-1:eml-1" }],
      [],
      [
        {
          projectId: "proj-1",
          accountId: "acc-1",
          defaultBranch: "main",
          name: "Support",
        },
      ],
      [{ agentName: "veyris", opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await dispatchResendEmailEvent(event);

    expect(threadEmailReads).toEqual([
      { inboxId: "inb-1", threadId: "thr-1", emailId: "eml-1" },
    ]);
    expect(continueCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].source).toBe("email");
    expect(createCalls[0].postCreate).toEqual([
      {
        type: "bind_chat_thread",
        platform: "email",
        workspaceId: "inb-1",
        threadId: "thr-1",
        createClaim: {
          key: "email:threadcreate:inb-1:thr-1",
          token: expect.any(String),
        },
      },
      expect.objectContaining({
        type: "deliver_prompt",
        source: "email",
        userId: "user-1",
      }),
    ]);
    const prompt: string = createCalls[0].postCreate[1].text;
    expect(prompt).toContain("Can you help?");
    expect(prompt).toContain("invoice.pdf");
    expectConnectorEmailPrompt(prompt);
    expect(createCalls[0].extraEnvVars.KORTIX_EMAIL_INBOX_ID).toBe("inb-1");
    expect(createCalls[0].extraEnvVars.KORTIX_EMAIL_THREAD_ID).toBe("thr-1");
    expect(createCalls[0].extraEnvVars.KORTIX_EMAIL_MESSAGE_ID).toBe("eml-1");
    expect(createCalls[0].body.connector_bindings).toEqual({
      email: { connection_id: "connection-email-1" },
    });
    expect(createCalls[0].body.agent_name).toBe("veyris");
    expect(createCalls[0].metadata).toMatchObject({
      source: "email",
      email: { inbox_id: "inb-1", thread_id: "thr-1", subject: "Need help" },
    });
    // Email has no initial_prompt: the subject titles the session at create,
    // and the full envelope reaches the agent through the postCreate prompt.
    expect(createCalls[0].body).not.toHaveProperty("initial_prompt");
    expect(createCalls[0].body.title_source).toBe("Need help");
    expect(createCalls[0].body.base_ref).toBe("main");
    expect(createCalls[0].mayManageSystemConnections).toBe(true);
    // One lifecycle key per email: the lifecycle keeps a key forever.
    expect(createCalls[0].idempotencyKey).toBe(
      "email:create:inb-1:thr-1:eml-1",
    );
    // A shared inbox runs as the automation actor, visible to the project.
    expect(createCalls[0].userId).toBe("user-1");
    expect(createCalls[0].visibility).toBe("project");
  });

  test("a private inbox's mail starts a private session as its owner, bound to that inbox's account", async () => {
    inboxOwner = { ownerType: "member", ownerId: "owner-7" };
    dbResults = [
      [{ eventId: "email:event:eml-1" }],
      [{ projectId: "proj-1" }],
      [{ eventId: "email:msg:inb-1:eml-1" }],
      [],
      [
        {
          projectId: "proj-1",
          accountId: "acc-1",
          defaultBranch: "main",
          name: "Support",
        },
      ],
      [{ agentName: null, opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await dispatchResendEmailEvent(event);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].userId).toBe("owner-7");
    expect(createCalls[0].visibility).toBe("private");
    expect(createCalls[0].body.connector_bindings).toEqual({
      email: { connection_id: "connection-email-1" },
    });
  });

  test("known thread routes a new email into the existing session", async () => {
    dbResults = [
      [{ eventId: "email:event:eml-1" }],
      [{ projectId: "proj-1" }],
      [{ eventId: "email:msg:inb-1:eml-1" }],
      [{ sessionId: "sess-1" }],
      [
        {
          connectionId: "connection-email-1",
          metadata: { inbox_id: "inb-1" },
          status: "active",
        },
      ],
      [{ accountId: "acc-1", connectorId: "conn-email" }],
      [{ accountId: "acc-1" }],
      [],
      [{ connectionId: "connection-email-1" }],
    ];

    await dispatchResendEmailEvent(event);

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-1");
    // One lifecycle key per received email, kept forever.
    expect(continueCalls[0].idempotencyKey).toBe("email:inb-1:eml-1");
    expect(continueCalls[0].projectId).toBe("proj-1");
    expect(continueCalls[0].text).toContain("Customer <customer@example.com>");
    expectConnectorEmailPrompt(continueCalls[0].text);
  });

  test("a thread whose session is gone starts a new session that knows it is a revival", async () => {
    deliverOutcome = "no-session";
    dbResults = [
      [{ eventId: "email:event:eml-1" }],
      [{ projectId: "proj-1" }],
      [{ eventId: "email:msg:inb-1:eml-1" }],
      [{ sessionId: "sess-old", projectId: "proj-1" }],
      // ensureEmailSessionBinding: the inbox account is still bound.
      [
        {
          connectionId: "connection-email-1",
          metadata: { inbox_id: "inb-1" },
          status: "active",
        },
      ],
      [{ accountId: "acc-1", connectorId: "conn-email" }],
      [{ accountId: "acc-1" }],
      [],
      [{ connectionId: "connection-email-1" }],
      // The stale thread is dropped, then the session plan reads the project and the binding.
      [],
      [
        {
          projectId: "proj-1",
          accountId: "acc-1",
          defaultBranch: "main",
          name: "Support",
        },
      ],
      [{ agentName: null, opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await dispatchResendEmailEvent(event);

    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-old");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].idempotencyKey).toBe("email:create:inb-1:thr-1:eml-1");
    expect(createCalls[0].postCreate[1].text).toContain(
      "NOTE: This email thread had an earlier conversation",
    );
    expect(dbResults).toHaveLength(0);
  });

  test("an inbox no project here owns is ignored before any body read", async () => {
    dbResults = [[{ eventId: "email:event:eml-1" }], []];
    await dispatchResendEmailEvent(event);
    expect(threadEmailReads).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("another event type (an outbound email) starts nothing", async () => {
    await dispatchResendEmailEvent({ ...event, type: "inbox.email.sent" });
    expect(threadEmailReads).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("a rejected sender never claims the email, reads its body or starts a session", async () => {
    setEmailSenderPolicyLoaderForTest(async () => ({
      mode: "restricted",
      allowedEmails: ["approved@example.com"],
      allowedDomains: [],
      allowedRegex: null,
    }));
    dbResults = [
      [{ eventId: "email:event:eml-1" }],
      [{ projectId: "proj-1" }],
      // Sentinels: past the policy, dispatch would claim and start a session.
      [{ eventId: "email:msg:inb-1:eml-1" }],
      [],
      [],
    ];

    await dispatchResendEmailEvent(event);

    expect(threadEmailReads).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(0);
    expect(dbResults).toHaveLength(3);
  });
});

describe("sender policy", () => {
  const restricted = (
    over: Partial<{
      allowedEmails: string[];
      allowedDomains: string[];
      allowedRegex: string | null;
    }>,
  ) => ({
    mode: "restricted" as const,
    allowedEmails: [],
    allowedDomains: [],
    allowedRegex: null,
    ...over,
  });

  test("exact emails, domains (and subdomains) and regex", () => {
    const policy = restricted({
      allowedEmails: ["customer@example.com"],
      allowedDomains: ["kortix.com"],
      allowedRegex: "^vip-[0-9]+@example\\.org$",
    });
    expect(
      isEmailSenderAllowed("Customer <customer@example.com>", policy),
    ).toBe(true);
    expect(
      isEmailSenderAllowed("Teammate <person@ops.kortix.com>", policy),
    ).toBe(true);
    expect(isEmailSenderAllowed("vip-12@example.org", policy)).toBe(true);
    expect(isEmailSenderAllowed("Other <other@external.test>", policy)).toBe(
      false,
    );
  });

  test("regex runtime stays linear and fails closed on unsupported syntax", () => {
    const adversarialSender = `${"a".repeat(50_000)}!@example.com`;
    const startedAt = performance.now();
    for (const allowedRegex of [
      "^(a{1,3})+@example\\.com$",
      "^(a|aa)+@example\\.com$",
      "^(?=a)a+@example\\.com$",
    ]) {
      expect(
        isEmailSenderAllowed(adversarialSender, restricted({ allowedRegex })),
      ).toBe(false);
    }
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("rejects ambiguous or attacker-controlled From values", () => {
    const policy = restricted({ allowedEmails: ["customer@example.com"] });
    expect(
      isEmailSenderAllowed("Customer <customer@example.com>", policy),
    ).toBe(true);
    expect(isEmailSenderAllowed("customer@example.com", policy)).toBe(true);
    expect(
      isEmailSenderAllowed("customer@example.com <attacker@evil.test>", policy),
    ).toBe(false);
    expect(
      isEmailSenderAllowed(
        "Attacker <attacker@evil.test>, customer@example.com",
        policy,
      ),
    ).toBe(false);
    expect(
      isEmailSenderAllowed("Customer <customer@example.com> trailing", policy),
    ).toBe(false);
    expect(isEmailSenderAllowed("Customer customer@example.com", policy)).toBe(
      false,
    );
  });

  test("allow_all lets anyone through", () => {
    expect(isEmailSenderAllowed("anyone@anywhere.test", ALLOW_ALL)).toBe(true);
  });
});

describe("stripHtml", () => {
  test("an HTML-only body becomes readable text: no scripts or styles, line breaks kept", () => {
    expect(
      stripHtml(
        '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>' +
          '<p>Hi&nbsp;there</p><div>Two<br/>lines</div><SCRIPT type="x">bad</SCRIPT >end ' +
          "<style>unclosed tail</body></html>",
      ),
    ).toBe("Hi there\nTwo\nlines\nend unclosed tail");
    expect(stripHtml("İİ<style>x</style>after")).toBe("İİafter");
  });

  test("crafted HTML costs linear time (a run of `<script` or `<` took seconds)", () => {
    for (const html of [
      "<".repeat(262_144),
      "<script".repeat(37_449),
      "<style".repeat(43_690),
      "<script" + "</script".repeat(32_768),
    ]) {
      const started = performance.now();
      stripHtml(html);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
