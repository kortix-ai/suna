import { expect, test } from "bun:test";
import { buildCatalog } from "./src/core/catalog";

test("audit and channel contracts remain discoverable with their routes and steps", async () => {
  const catalog = await buildCatalog();
  const flows = catalog.domains.flatMap((domain) => domain.flows)
    .filter((flow) => flow.id.startsWith("AUD-") || ["CHN-32", "CHN-33"].includes(flow.id));
  expect(flows).toEqual([
  {
    "id": "AUD-1",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/accounts/:accountId/audit"
    ],
    "steps": [
      "OWNER lists audit events \u2192 200 with events array",
      "limit/action filter honored \u2192 200",
      "NONMEMBER \u2192 403"
    ]
  },
  {
    "id": "AUD-2",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/accounts/:accountId/audit/export"
    ],
    "steps": [
      "export defaults to CSV \u2192 200 text/csv",
      "export format=jsonl \u2192 200 ndjson",
      "invalid format \u2192 400",
      "NONMEMBER \u2192 403"
    ]
  },
  {
    "id": "AUD-3",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/accounts/:accountId/audit/webhooks"
    ],
    "steps": [
      "OWNER lists webhooks \u2192 200 with webhooks array",
      "NONMEMBER \u2192 403"
    ]
  },
  {
    "id": "AUD-4",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "POST /v1/accounts/:accountId/audit/webhooks",
      "PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId",
      "DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId"
    ],
    "steps": [
      "create webhook \u2192 201, secret revealed once",
      "create with missing url \u2192 400",
      "create with bad url scheme \u2192 400",
      "NONMEMBER cannot create \u2192 403",
      "patch: disable webhook \u2192 200",
      "patch unknown webhook id \u2192 404",
      "delete webhook \u2192 200 deleted",
      "delete already-deleted webhook \u2192 404"
    ]
  },
  {
    "id": "AUD-5",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/accounts/:accountId/audit",
      "GET /v1/accounts/:accountId/audit/export",
      "GET /v1/accounts/:accountId/audit/webhooks",
      "POST /v1/accounts/:accountId/audit/webhooks",
      "PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId",
      "DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId"
    ],
    "steps": [
      "ANON list events \u2192 401",
      "ANON export \u2192 401",
      "ANON list webhooks \u2192 401",
      "ANON create webhook \u2192 401",
      "MEMBER list events \u2192 403 (no audit.read)",
      "MEMBER export \u2192 403",
      "MEMBER list webhooks \u2192 403 (no account.write)",
      "MEMBER create webhook \u2192 403",
      "limit=0 \u2192 400",
      "limit=-5 \u2192 400",
      "limit=abc \u2192 400",
      "limit=99999 \u2192 400",
      "cursor pagination \u2192 no overlap between pages",
      "export CSV \u2192 X-Audit-Row-Count + Content-Disposition headers",
      "export format=CSV (uppercase) \u2192 400 (schema accepts lowercase csv|jsonl)",
      "create with missing name \u2192 400",
      "create with oversize name (>128 chars) \u2192 400",
      "create with malformed url \u2192 400",
      "create with SSRF target (169.254.169.254 cloud metadata) \u2192 400",
      "create reveals secret once \u2192 201",
      "subsequent GET list does NOT reveal secret",
      "PATCH response does NOT reveal secret",
      "cross-account PATCH (teamA hook via teamB path) \u2192 404",
      "cross-account DELETE (teamA hook via teamB path) \u2192 404",
      "teamA webhook still exists after cross-account no-ops"
    ]
  },
  {
    "id": "AUD-6",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/projects/:projectId/audit",
      "POST /v1/accounts/:accountId/audit/reconcile",
      "GET /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries",
      "POST /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries/:deliveryId/replay",
      "POST /v1/projects/:projectId/sessions/:sessionId/audit/events",
      "POST /v1/accounts/:accountId/audit/webhooks",
      "DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId"
    ],
    "steps": [
      "project-scoped canonical audit page \u2192 200",
      "create a webhook scoped to reconciliation events",
      "bounded reconciliation \u2192 200 idempotent result",
      "delivery ledger contains the reconciliation event",
      "manual delivery replay returns replayed=true",
      "human auth cannot ingest sandbox OpenCode events \u2192 403",
      "delete the test webhook"
    ]
  },
  {
    "id": "AUD-7",
    "domain": "audit",
    "tags": [],
    "requires": [
      "database"
    ],
    "todo": null,
    "routes": [
      "POST /v1/accounts/tokens",
      "GET /v1/git/:project/info/refs",
      "POST /v1/git/:project/git-upload-pack",
      "POST /v1/git/:project/git-receive-pack",
      "GET /v1/projects/:projectId",
      "GET /v1/accounts/:accountId/audit"
    ],
    "steps": [
      "the owner clones through the Git proxy; a git.clone row names the owner and the token",
      "the owner pushes a new branch; a git.push row records the ref it created",
      "the owner deletes the branch; its git.push row records the delete",
      "an account member with no project role is refused, and the refusal names them",
      "a project member without gitops.push is refused a push, and the refusal names them",
      "an unauthenticated request to the project is an anonymous row in the owner\u2019s log",
      "the actor_type filter still refuses an unknown type \u2192 400"
    ]
  },
  {
    "id": "AUD-8",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/projects/:projectId",
      "POST /v1/accounts/:accountId/iam/groups",
      "DELETE /v1/accounts/:accountId/iam/groups/:groupId",
      "GET /v1/accounts/:accountId/audit"
    ],
    "steps": [
      "the owner reads the project; its row is ",
      "the ",
      "creating a group writes one row: the handler",
      "a row stores the X-Forwarded-For entry that KORTIX_TRUSTED_PROXY_HOPS (2) selects, for a handler row and a request row",
      "a request no endpoint matched is "
    ]
  },
  {
    "id": "AUD-CRED",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/projects/:projectId",
      "GET /v1/accounts/:accountId/audit",
      "POST /v1/accounts/tokens"
    ],
    "steps": [
      "mint a personal access token as OWNER \u2192 201",
      "browser JWT \u2192 credential_kind browser_session, no reported client",
      "PAT \u2192 credential_kind personal_access_token with the token id and name",
      "PAT that sends X-Kortix-Client: web is still a personal_access_token",
      "credential_kind filter selects the PAT rows only"
    ]
  },
  {
    "id": "AUD-FILTER",
    "domain": "audit",
    "tags": [],
    "requires": [],
    "todo": null,
    "routes": [
      "GET /v1/accounts/:accountId/audit",
      "GET /v1/projects/:projectId"
    ],
    "steps": [
      "a spoofed client header changes nothing: the row records the credential",
      "a credential_kind filter that matches no row returns none",
      "session filter accepts an exact session identifier",
      "invalid structured filters \u2192 400",
      "actor filter (uuid) \u2192 200 with events envelope",
      "resource_type prefix filter \u2192 200",
      "since + until date-range window \u2192 200",
      "q search substring \u2192 200",
      "cursor pagination param accepted \u2192 200",
      "limit=0 is rejected \u2192 400",
      "limit=99999 is rejected \u2192 400",
      "malformed since date is rejected \u2192 400",
      "combined filters (actor + resource_type + q + window) \u2192 200"
    ]
  },
  {
    "id": "CHN-32",
    "domain": "channels",
    "tags": [],
    "requires": [
      "database"
    ],
    "todo": null,
    "routes": [
      "POST /v1/projects/:projectId/secrets",
      "POST /v1/webhooks/slack/:projectId/commands"
    ],
    "steps": [
      "the channel is bound to the project with a pinned model and the default policy",
      "a linked project member without connector.write is refused a model, agent and policy change; the binding is unchanged",
      "an unlinked Slack user is asked to connect, and the binding is unchanged",
      "the linked project manager resets the model and sets the policy; the binding records both"
    ]
  },
  {
    "id": "CHN-33",
    "domain": "channels",
    "tags": [],
    "requires": [
      "database"
    ],
    "todo": null,
    "routes": [
      "POST /v1/projects/:projectId/secrets",
      "POST /v1/webhooks/slack/:projectId/commands"
    ],
    "steps": [
      "three Slack-started sessions exist: the owner",
      "the linked member sees their own session and the project-visible one, never the owner",
      "an unlinked Slack user is asked to connect and sees no session"
    ]
  }
]);
});
