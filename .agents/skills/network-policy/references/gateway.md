# Network policy gateway design (KRTX-259)

Status: design only. No sandbox egress is blocked by this document. Do not advertise enforcement until the isolation and bypass tests below pass.

## Boundary

The current in-guest egress shim (`apps/kortix-sandbox-agent-server/src/services/egress-shim/shim.ts`) is **not** a network-policy enforcement point. It starts only when a network-bound secret is granted, tunnels other destinations blind, and clients can ignore proxy environment variables. The API sandbox preview proxy carries inbound traffic, not outbound traffic. Neither can claim to intercept every outbound call.

Place enforcement at the sandbox network boundary, outside the guest: all outbound TCP and UDP from the sandbox network namespace must route through a provider-controlled egress gateway. Default-deny direct internet routes, alternate interfaces, IPv6 and DNS paths. Permit only the authenticated gateway transport and necessary control-plane callbacks at the network layer. A provider that cannot enforce this route cannot opt into network policy. Do not rely on `HTTP_PROXY`, DNS filtering alone, or an in-guest process to enforce it. The existing secret shim remains a separate credential-substitution layer; it must not grant an implicit network-policy exception.

The gateway authenticates the sandbox identity from the transport, not an untrusted request header. It resolves the bound project, session and agent identity server-side. For every new connection or HTTP request, it sends destination (normalized DNS name or IP, port, protocol), method when available, and the authenticated scope to the central policy evaluator. A tunnel to an uninspectable protocol is denied unless explicitly authorized as an opaque connection. DNS resolutions must be pinned to the evaluated address and checked again on connect to prevent DNS rebinding; reject private, loopback and link-local destinations unless an explicit internal policy grants them. No fail-open when the evaluator is unavailable. A decision applies to exactly one connection/request, with a bounded lifetime; redirects require a new decision. HTTP/2 multiplexing and QUIC must not reuse an approval for another authority.

## Policy format (version 1)

Store policy in the control plane, never inside the guest. Validate with a strict discriminated schema at write time, reject unknown versions, action classes and duplicate rule ids, and compile a read-only snapshot for the gateway. An example (synthetic):

```json
{
  "version": 1,
  "default": "deny",
  "rules": [
    {
      "id": "allow-docs-read",
      "effect": "allow",
      "scope": { "agentId": "agent-example", "action": "http.read" },
      "destination": { "host": "docs.example.test", "ports": [443], "protocol": "tcp" }
    }
  ]
}
```

`effect` is `allow` or `deny`. `scope.agentId` is an exact agent identifier; `scope.action` is an exact, registered action class, never text supplied by the guest without a trusted binding. `destination.host` is an exact, normalized hostname, not a suffix or wildcard. IP/CIDR rules need a separately reviewed format. Only matching `allow` rules can allow a call; any matching `deny` wins. An empty match denies. Invalid or missing scope denies. Bind the action class at the trusted invocation layer before sending work to the sandbox; raw shell traffic without a verified action class has the `unknown` class and is denied unless explicitly allowed. Policy updates replace the whole versioned snapshot atomically, with an audit record of actor, version and decision metadata but no request body, credentials or customer URL paths.

## Rollout and acceptance gates

1. Implement schema validation, evaluator and table-driven cases for allow, explicit deny, default deny, wrong agent, wrong action, invalid destination, malformed policy and policy outage. A policy write needs project authorization.
2. Implement provider network isolation and gateway routing for each enabled sandbox provider. An unsupported provider fails provisioning under enforcement rather than falling back to unrestricted egress. Verify with real sandbox processes using proxy-aware and proxy-ignoring clients, direct IP, DNS rebinding, IPv6, UDP/QUIC, HTTP CONNECT, redirects and a gateway outage.
3. Run in observe-only mode on synthetic traffic first, with decision metrics and no payload logging. Enable deny enforcement per project only after isolation tests pass on that provider. Roll back by disabling the per-project mode; do not change an enforced project to an unrestricted network without an explicit operator decision.

The classifier/GPU direction is a future implementation choice, not a required dependency for a deterministic policy evaluator. A classifier may propose action classes, but it must not override an explicit deny or turn an unverifiable class into an allow.
