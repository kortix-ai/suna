import { describe, expect, test } from "bun:test";

import {
  findBoundaryDestinationConflict,
  networkBoundaryPolicyError,
  resolveNetworkBoundaryBindings,
} from "./network-boundary";
import type { ResolvedWorkspaceSecret } from "../workspaces/secrets";

function secret(
  extra: Partial<ResolvedWorkspaceSecret> = {},
): ResolvedWorkspaceSecret {
  return {
    secretId: "primary",
    identifier: "billing-api",
    key: "BILLING_API_KEY",
    value: "test-secret-value",
    strategy: "egress",
    consumer: "network",
    egressPolicy: {
      rules: [{ host: "api.example.com" }],
      inject: {
        kind: "header",
        name: "authorization",
        template: "Bearer {{secret}}",
      },
      on_no_match: "deny",
    },
    ...extra,
  };
}

describe("networkBoundaryPolicyError", () => {
  test("accepts exact hosts with one common header transform", () => {
    expect(networkBoundaryPolicyError(secret().egressPolicy!)).toBeNull();
  });

  test.each<[string, NonNullable<ResolvedWorkspaceSecret["egressPolicy"]>]>([
    [
      "wildcard host",
      { ...secret().egressPolicy!, rules: [{ host: "*.example.com" }] },
    ],
    [
      "method filter",
      {
        ...secret().egressPolicy!,
        rules: [{ host: "api.example.com", methods: ["POST"] }],
      },
    ],
    [
      "path filter",
      {
        ...secret().egressPolicy!,
        rules: [{ host: "api.example.com", path: "/v1/*" }],
      },
    ],
    [
      "query injection",
      { ...secret().egressPolicy!, inject: { kind: "query", name: "token" } },
    ],
  ])("rejects %s because the provider cannot enforce it", (_name, policy) => {
    expect(networkBoundaryPolicyError(policy)).not.toBeNull();
  });

  test("rejects per-host transforms that disagree", () => {
    const row = secret({
      egressPolicy: {
        rules: [
          { host: "api.example.com" },
          {
            host: "uploads.example.com",
            inject: { kind: "header", name: "x-api-key" },
          },
        ],
        inject: { kind: "header", name: "authorization" },
      },
    });

    expect(networkBoundaryPolicyError(row.egressPolicy!)).toContain(
      "same header",
    );
  });
});

describe("resolveNetworkBoundaryBindings", () => {
  test("renders the header value and never emits an environment placeholder", () => {
    const result = resolveNetworkBoundaryBindings([secret()], {
      sessionId: "session-1",
      agentGrantEnv: ["billing-api"],
      sessionAllowlist: ["billing-api"],
    });

    expect(result).toEqual([
      {
        secretId: "primary",
        identifier: "billing-api",
        alias: "KORTIX_primary",
        hosts: ["api.example.com"],
        header: "authorization",
        value: "Bearer test-secret-value",
        onEcho: "block",
      },
    ]);
  });

  test("withholds a boundary secret from an implicit all grant", () => {
    expect(
      resolveNetworkBoundaryBindings([secret()], {
        sessionId: "session-1",
        agentGrantEnv: "all",
        sessionAllowlist: null,
      }),
    ).toEqual([]);
  });

  test("withholds a boundary secret excluded by the session allowlist", () => {
    expect(
      resolveNetworkBoundaryBindings([secret()], {
        sessionId: "session-1",
        agentGrantEnv: ["billing-api"],
        sessionAllowlist: [],
      }),
    ).toEqual([]);
  });

  test("fails closed when two secrets target the same host and header", () => {
    expect(() =>
      resolveNetworkBoundaryBindings(
        [
          secret(),
          secret({
            secretId: "backup",
            identifier: "billing-backup",
            key: "BILLING_BACKUP_KEY",
          }),
        ],
        {
          sessionId: "session-1",
          agentGrantEnv: ["billing-api", "billing-backup"],
          sessionAllowlist: null,
        },
      ),
    ).toThrow("api.example.com");
  });
});

function policy(
  hosts: string[],
  header: string,
): NonNullable<ResolvedWorkspaceSecret["egressPolicy"]> {
  return {
    rules: hosts.map((host) => ({ host })),
    inject: { kind: "header", name: header, template: "Bearer {{secret}}" },
    on_no_match: "deny",
  };
}

describe("findBoundaryDestinationConflict", () => {
  test("reports the secret that already claims the same host and header", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["api.example.com"], "authorization"),
        },
        [
          {
            identifier: "billing-api",
            policy: policy(["api.example.com"], "authorization"),
          },
        ],
      ),
    ).toEqual({
      identifier: "billing-api",
      host: "api.example.com",
      header: "authorization",
    });
  });

  test("allows one host to carry two secrets under different headers", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["api.example.com"], "x-api-key"),
        },
        [
          {
            identifier: "billing-api",
            policy: policy(["api.example.com"], "authorization"),
          },
        ],
      ),
    ).toBeNull();
  });

  test("does not collide a secret with its own stored row", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-api",
          policy: policy(["api.example.com"], "authorization"),
        },
        [
          {
            identifier: "billing-api",
            policy: policy(["api.example.com"], "authorization"),
          },
        ],
      ),
    ).toBeNull();
  });

  test("compares host and header case-insensitively", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["API.Example.COM"], "Authorization"),
        },
        [
          {
            identifier: "billing-api",
            policy: policy(["api.example.com"], "authorization"),
          },
        ],
      ),
    ).toEqual({
      identifier: "billing-api",
      host: "api.example.com",
      header: "authorization",
    });
  });

  test("skips a secret that has no outbound policy", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["api.example.com"], "authorization"),
        },
        [
          { identifier: "plain-runtime", policy: null },
          {
            identifier: "billing-api",
            policy: policy(["other.example.com"], "authorization"),
          },
        ],
      ),
    ).toBeNull();
  });

  test("skips a secret injected somewhere other than a header", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["api.example.com"], "authorization"),
        },
        [
          {
            identifier: "billing-api",
            policy: {
              rules: [{ host: "api.example.com" }],
              inject: { kind: "query", name: "authorization" },
            },
          },
        ],
      ),
    ).toBeNull();
  });

  test("reports a conflict on any overlapping host of a multi-host policy", () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: "billing-backup",
          policy: policy(["a.example.com", "b.example.com"], "authorization"),
        },
        [
          {
            identifier: "billing-api",
            policy: policy(["c.example.com", "b.example.com"], "authorization"),
          },
        ],
      ),
    ).toEqual({
      identifier: "billing-api",
      host: "b.example.com",
      header: "authorization",
    });
  });

  test("agrees with the provision-time throw on the same pair of policies", () => {
    const first = secret({
      egressPolicy: policy(["API.Example.com"], "Authorization"),
    });
    const second = secret({
      secretId: "backup",
      identifier: "billing-backup",
      key: "BILLING_BACKUP_KEY",
      egressPolicy: policy(["api.example.COM"], "authorization"),
    });

    expect(
      findBoundaryDestinationConflict(
        { identifier: second.identifier, policy: second.egressPolicy! },
        [{ identifier: first.identifier, policy: first.egressPolicy! }],
      ),
    ).toEqual({
      identifier: "billing-api",
      host: "api.example.com",
      header: "authorization",
    });

    expect(() =>
      resolveNetworkBoundaryBindings([first, second], {
        sessionId: "session-1",
        agentGrantEnv: ["billing-api", "billing-backup"],
        sessionAllowlist: null,
      }),
    ).toThrow(
      "billing-api and billing-backup both target api.example.com header authorization",
    );
  });
});
