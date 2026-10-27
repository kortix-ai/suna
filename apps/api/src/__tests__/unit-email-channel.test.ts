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

/** One result per awaited query, in order; an Error makes that query throw. */
let dbResults: Array<unknown[] | Error> = [];

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
  chain.then = (
    resolve: (rows: unknown[]) => unknown,
    reject: (error: unknown) => unknown,
  ) => {
    const next = dbResults.shift() ?? [];
    return next instanceof Error
      ? Promise.reject(next).then(resolve, reject)
      : Promise.resolve(resolve(next));
  };
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

// The inbox account (its webhook signing secret, own key, owner, sender
// policy) has its own tests; here it is fixed so each DB queue below is only
// the route or consumer path.
let inboxWebhookSecret: string | null = null;
let inboxRemoved = false;
let inboxPolicy: {
  mode: "allow_all" | "restricted";
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
} = { mode: "allow_all", allowedEmails: [], allowedDomains: [], allowedRegex: null };
let inboxOwner: { ownerType: "project" | "member"; ownerId: string | null } = {
  ownerType: "project",
  ownerId: null,
};
const realInstallStore = await import("../channels/install-store");
mock.module("../channels/install-store", () => ({
  ...realInstallStore,
  emailWebhookSecretForAccount: async () => inboxWebhookSecret,
  emailOwnKeyForInbox: async () => null,
  emailOwnKeyForAccount: async () => null,
  loadEmailInboxAccountForInbox: async (
    _projectId: string,
    inboxId: string,
  ) => inboxRemoved ? null : ({
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
    senderPolicy: inboxPolicy,
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
  emailMessageEvent,
  handleEmailEvent,
  isEmailSenderAllowed,
  resetEmailChannelForTest,
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
    email: {
      id: "eml-1",
      from: "Customer <customer@example.com>",
      to: ["agent@example.com"],
      subject: "Need help",
    },
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
  inboxRemoved = false;
  inboxPolicy = ALLOW_ALL;
  inboxOwner = { ownerType: "project", ownerId: null };
  (config as { RESEND_API_KEY: string | undefined }).RESEND_API_KEY =
    "re_managed_test";
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
      verifyEmailWebhookSignature({ ...input, secret: `whsec_${"b3RoZXI="}` }),
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

      // Signed: the email is stored, then acked. The consumer reads its body later.
      dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], [{ jobId: "job-1" }]];
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
      expect(threadEmailReads).toHaveLength(0);
      expect(dbResults).toHaveLength(0);
      expect(
        resendCalls.every((url) => url.startsWith("https://api.resend.com/")),
      ).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Resend webhook: store, then ack", () => {
  const SECRET = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;
  const post = (body: unknown, id: string) => {
    const rawBody = JSON.stringify(body);
    return emailWebhookApp.request("/resend", {
      method: "POST",
      headers: { "content-type": "application/json", ...signed(rawBody, id) },
      body: rawBody,
    });
  };

  test("an email Resend sends again is acked and stays stored once", async () => {
    inboxWebhookSecret = SECRET;
    // The insert conflicts with the stored email: no row comes back.
    dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], []];
    const res = await post(event, "msg_again");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dbResults).toHaveLength(0);
  });

  test("the sender policy reads the sender from the event's email headers (data.email.from)", async () => {
    inboxWebhookSecret = SECRET;
    inboxPolicy = {
      mode: "restricted",
      allowedEmails: ["customer@example.com"],
      allowedDomains: [],
      allowedRegex: null,
    };
    dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], [{ jobId: "job-1" }]];
    const res = await post(event, "msg_allowed");
    expect(await res.json()).toEqual({ ok: true });
    expect(dbResults).toHaveLength(0);
  });

  test("a sender the inbox does not allow is acked as ignored and never stored", async () => {
    inboxWebhookSecret = SECRET;
    inboxPolicy = {
      mode: "restricted",
      allowedEmails: ["approved@example.com"],
      allowedDomains: [],
      allowedRegex: null,
    };
    // Sentinel: past the policy, the route would store the email.
    dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], [{ jobId: "job-1" }]];
    const res = await post(event, "msg_stranger");
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(dbResults).toEqual([[{ jobId: "job-1" }]]);
  });

  test("a store that fails answers 500, so Resend retries the email", async () => {
    inboxWebhookSecret = SECRET;
    dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], new Error("db down")];
    const res = await post(event, "msg_down");
    expect(res.status).toBe(500);
    expect(dbResults).toHaveLength(0);
  });

  test("an event that is not a received email is acked as ignored and never stored", async () => {
    inboxWebhookSecret = SECRET;
    dbResults = [[{ projectId: "proj-1" }], [CHANNEL_ON], [{ jobId: "job-1" }]];
    const res = await post({ ...event, type: "inbox.email.sent" }, "msg_sent");
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(dbResults).toHaveLength(1);
    expect(emailMessageEvent("proj-1", { ...event, data: { ...event.data, email_id: "" } })).toBeNull();
  });

  test("the stored envelope holds the ids and headers, never a body", () => {
    expect(emailMessageEvent("proj-1", event)).toEqual({
      id: "eml-1",
      source: "email:inb-1",
      type: "email.message.received",
      time: "2026-10-24T10:00:00.000Z",
      subject: "thr-1",
      projectId: "proj-1",
      data: {
        inbox_id: "inb-1",
        thread_id: "thr-1",
        email_id: "eml-1",
        from: "Customer <customer@example.com>",
        to: ["agent@example.com"],
        subject: "Need help",
      },
    });
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

describe("handleEmailEvent", () => {
  const stored = () => emailMessageEvent("proj-1", event)!;
  const PROJECT_ROW = {
    projectId: "proj-1",
    accountId: "acc-1",
    defaultBranch: "main",
    name: "Support",
  };
  // ensureEmailSessionBinding: the inbox account is bound to the session.
  const BOUND = [
    [{ connectionId: "connection-email-1", metadata: { inbox_id: "inb-1" }, status: "active" }],
    [{ accountId: "acc-1", connectorId: "conn-email" }],
    [{ accountId: "acc-1" }],
    [],
    [{ connectionId: "connection-email-1" }],
  ];

  test("first email reads its body and creates one project-visible session bound to the thread", async () => {
    dbResults = [
      [CHANNEL_ON],
      [],
      [PROJECT_ROW],
      [{ agentName: "veyris", opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await handleEmailEvent(stored(), { finalAttempt: true });

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
    expect(dbResults).toHaveLength(0);
  });

  test("a private inbox's mail starts a private session as its owner, bound to that inbox's account", async () => {
    inboxOwner = { ownerType: "member", ownerId: "owner-7" };
    dbResults = [
      [CHANNEL_ON],
      [],
      [PROJECT_ROW],
      [{ agentName: null, opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await handleEmailEvent(stored(), { finalAttempt: true });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].userId).toBe("owner-7");
    expect(createCalls[0].visibility).toBe("private");
    expect(createCalls[0].body.connector_bindings).toEqual({
      email: { connection_id: "connection-email-1" },
    });
    expect(dbResults).toHaveLength(0);
  });

  test("known thread routes a new email into the existing session", async () => {
    dbResults = [[CHANNEL_ON], [{ sessionId: "sess-1", projectId: "proj-1" }], ...BOUND];

    await handleEmailEvent(stored(), { finalAttempt: true });

    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-1");
    // One lifecycle key per received email, kept forever.
    expect(continueCalls[0].idempotencyKey).toBe("email:inb-1:eml-1");
    expect(continueCalls[0].projectId).toBe("proj-1");
    expect(continueCalls[0].text).toContain("Customer <customer@example.com>");
    expectConnectorEmailPrompt(continueCalls[0].text);
    expect(dbResults).toHaveLength(0);
  });

  test("a thread whose session is gone starts a new session that knows it is a revival", async () => {
    deliverOutcome = "no-session";
    dbResults = [
      [CHANNEL_ON],
      [{ sessionId: "sess-old", projectId: "proj-1" }],
      ...BOUND,
      // The stale thread is dropped, then the session plan reads the project and the binding.
      [],
      [PROJECT_ROW],
      [{ agentName: null, opencodeModel: null }],
      [{ eventId: "email:threadcreate:inb-1:thr-1" }],
    ];

    await handleEmailEvent(stored(), { finalAttempt: true });

    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0].sessionId).toBe("sess-old");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].idempotencyKey).toBe("email:create:inb-1:thr-1:eml-1");
    expect(createCalls[0].postCreate[1].text).toContain(
      "NOTE: This email thread had an earlier conversation",
    );
    expect(dbResults).toHaveLength(0);
  });

  test("an email whose project turned the channel off, or removed the inbox, since the ack is dropped unread", async () => {
    dbResults = [[{ metadata: {} }]];
    await handleEmailEvent(stored(), { finalAttempt: false });
    inboxRemoved = true;
    // No project holds the inbox now.
    dbResults = [[]];
    await handleEmailEvent(stored(), { finalAttempt: false });
    expect(threadEmailReads).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(dbResults).toHaveLength(0);
  });

  test("a sender the inbox stopped allowing since the ack is dropped unread", async () => {
    inboxPolicy = {
      mode: "restricted",
      allowedEmails: ["approved@example.com"],
      allowedDomains: [],
      allowedRegex: null,
    };
    dbResults = [[CHANNEL_ON]];
    await handleEmailEvent(stored(), { finalAttempt: false });
    expect(threadEmailReads).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(continueCalls).toHaveLength(0);
    expect(dbResults).toHaveLength(0);
  });

  test("a body read that fails throws, so the stored email is retried", async () => {
    setThreadEmailLoaderForTest(async () => {
      throw new Error("Resend 503");
    });
    dbResults = [[CHANNEL_ON]];
    await expect(handleEmailEvent(stored(), { finalAttempt: false })).rejects.toThrow("Resend 503");
    expect(createCalls).toHaveLength(0);
    expect(dbResults).toHaveLength(0);
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
    // A `<` inside an attribute stays inside its tag; a `<` in text stays text.
    expect(stripHtml('<img alt="a<b">Text')).toBe("Text");
    expect(stripHtml("<p>a < b and c > d</p>")).toBe("a < b and c > d");
    // An unclosed <style> stays as text and does not stop a later <script> from going.
    expect(stripHtml("Hi<style>a{}Body<script>secret()</script>")).toBe("Hia{}Body");
    // Entities decode once: an escaped entity stays text, never a tag.
    expect(stripHtml("<p>&amp;lt;script&amp;gt; &lt;b&gt; &amp;amp;</p>")).toBe("&lt;script&gt; <b> &amp;");
  });

  test("crafted HTML costs linear time (a run of `<script` or `<` took seconds)", () => {
    for (const html of [
      "<".repeat(262_144),
      "<script".repeat(37_449),
      "<style".repeat(43_690),
      "<script" + "</script".repeat(32_768),
      "<".repeat(262_144) + ">",
      "<a".repeat(131_072),
      "<style".repeat(20_000) + "<script>x</script>".repeat(10_000),
    ]) {
      const started = performance.now();
      stripHtml(html);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
