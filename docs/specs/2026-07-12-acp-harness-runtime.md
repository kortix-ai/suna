# ACP-first harness runtime

Status: executable first slice implemented; platform migration in progress
Date: 2026-07-12

## Decision

ACP is the canonical protocol between coding-agent harnesses and Kortix. OpenCode is one harness behind that boundary, not the platform API. Kortix does not translate ACP into AG-UI, Vercel AI SDK messages, or an OpenCode-shaped universal schema for its own clients.

The target path is:

```text
kortix.yaml
  -> Kortix runtime compiler
  -> official ACP agent process in the sandbox
  -> authenticated raw ACP-over-HTTP bridge
  -> @kortix/sdk ACP session store
  -> web/mobile/embedded UI projections
```

The first supported process matrix is:

| Harness | ACP process | Upstream implementation |
| --- | --- | --- |
| Claude Code | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |
| Codex | `codex-acp` | `@agentclientprotocol/codex-acp` |
| OpenCode | `opencode acp` | Native OpenCode ACP mode |
| Pi | `pi-acp` | Community Pi ACP adapter |

The Claude and Codex processes are adapters maintained in the Agent Client Protocol organization. They already expose the harness features Kortix needs: session create/load, auth methods, model and mode configuration, permission requests, elicitation, MCP servers, tool progress, terminal output, file edits, images, plans, token usage, and session metadata.

## Why ACP, not AG-UI

AG-UI is useful between an application backend and a conversational UI. It is not necessary between a coding harness and Kortix because ACP already specifies the bidirectional coding-agent contract. Translating ACP into AG-UI at the runtime boundary would discard or re-invent coding-specific semantics such as permission responses, terminal sessions, session loading, config options, and client-provided MCP servers.

UI libraries may consume a projection of canonical ACP state later. They must not become the persistence or runtime protocol.

## Configuration ownership

`kortix.yaml` registers logical Kortix agents and selects a native runtime. It does not translate prompts, models, providers, hooks, or native agent definitions.

```yaml
kortix_version: 3
default_agent: kortix

runtimes:
  claude:
    harness: claude
    config_dir: .claude

  codex:
    harness: codex
    config_dir: .codex

  opencode:
    harness: opencode
    config_dir: .kortix/opencode

agents:
  kortix:
    runtime: claude
    agent: default
    skills: all
    connectors: all
    secrets: all

  reviewer:
    runtime: codex
    agent: reviewer
    skills: [code-review]
    connectors: [github]
```

The `agent` field is optional and means a harness-native agent/profile identifier. Omission selects the native default. The compiler validates registrations and produces a launch plan; it does not manufacture neutral definition files or duplicate native model/provider configuration.

## Runtime and session identity

Three identities must remain distinct:

```ts
type RuntimeSessionIdentity = {
  projectSessionId: string // durable Kortix identity
  runtimeId: string        // current sandbox allocation
  acpSessionId: string     // harness-native ACP session
}
```

The project session survives sandbox replacement. The ACP session is returned by `session/new` or selected by `session/load`. Neither should be overloaded into the sandbox id.

## Sandbox transport

The daemon exposes a raw, signed-context-protected ACP bridge:

```text
GET    /acp
POST   /acp/:serverId?agent=claude
POST   /acp/:serverId
GET    /acp/:serverId
DELETE /acp/:serverId
```

The first `POST` lazily starts exactly one official ACP stdio process for the client-chosen `serverId`; it must include `agent`. Later requests reuse the process. Supplying a different agent for an existing server returns `409`. `DELETE` is idempotent and terminates the full process.

`POST` accepts one unmodified JSON-RPC 2.0 envelope. Requests wait for the matching response. Notifications and client responses return `202`. A write queue serializes stdin writes but does not serialize request lifetimes; a long `session/prompt` must not block the client from answering an agent-originated permission request.

`GET` is SSE. It streams agent-originated requests and notifications as:

```text
id: 17
data: {"jsonrpc":"2.0","method":"session/update","params":{...}}
```

`Last-Event-ID` replays buffered events after the supplied sequence. The first slice keeps a bounded in-memory buffer. Durable persistence moves to the cloud API/SDK layer and stores ordered, raw ACP envelopes.

All `/acp` routes are behind the existing `X-Kortix-User-Context` HMAC gate. Health remains unauthenticated. Harness processes inherit only the sandbox environment plus the current filtered project-secret snapshot.

## Authentication and providers

MVP credentials are environment based:

- Claude: `ANTHROPIC_API_KEY`.
- Codex: `OPENAI_API_KEY` or `CODEX_API_KEY`.
- OpenCode: its native provider environment/configuration.

Later, user-scoped encrypted credentials add Claude setup tokens and Codex device-login state. Subscription credentials must never be committed, copied into project configuration, or shared across users by default.

Codex can use custom model providers through its native config and Responses-compatible gateways. Claude Code officially targets Claude models through Anthropic-compatible gateways and supported cloud providers. Kortix's gateway should add Codex Responses routing first; Claude requires an Anthropic Messages-compatible gateway surface.

## Packaging

The sandbox image, not a request handler, installs pinned ACP adapter versions. Runtime requests must never run unpinned `npx` installs. Image construction verifies each adapter with a version/help probe and keeps OpenCode's existing pinned native install.

The daemon supports explicit path and JSON-argument overrides for testing and controlled rollouts:

```text
KORTIX_ACP_CLAUDE_PATH
KORTIX_ACP_CLAUDE_ARGS
KORTIX_ACP_CODEX_PATH
KORTIX_ACP_CODEX_ARGS
KORTIX_ACP_OPENCODE_PATH
KORTIX_ACP_OPENCODE_ARGS
KORTIX_ACP_PI_PATH
KORTIX_ACP_PI_ARGS
```

Argument values are JSON string arrays, avoiding shell parsing and injection.

## Canonical persistence and UI

The durable transcript is an append-only ordered log of raw inbound and outbound ACP envelopes plus transport metadata (`projectSessionId`, `runtimeId`, `serverId`, sequence, timestamp, direction). JSONL is the lossless export. Markdown and HTML are projections.

`@kortix/sdk` owns:

- authenticated ACP transport;
- reconnect and `Last-Event-ID` replay;
- ACP session identity;
- the canonical normalized client state derived from raw envelopes;
- permission and elicitation responses;
- transcript export and projections.

Hosts consume one SDK session hook. React components render SDK state and never import a harness SDK or call the sandbox directly.

## Migration sequence

1. Land and verify the authenticated sandbox ACP process bridge with a real mock process.
2. Bake and smoke-test the official Claude/Codex adapters in the sandbox image.
3. Add v3 runtime/agent manifest parsing and a launch-plan compiler while retaining v2 behavior.
4. Add cloud API proxying and durable raw-envelope persistence keyed by the three-part session identity.
5. Add `@kortix/sdk` ACP transport/state and transcript projections.
6. Move web permissions, questions, tool parts, models, and session lifecycle to the SDK ACP surface.
7. Route OpenCode through `opencode acp` and prove parity.
8. Remove the OpenCode HTTP compatibility surface, OpenCode-specific cloud session mapping, and host-local OpenCode hooks only after parity and transcript migration are proven.

## Explicit non-goals of the first slice

- Removing the current OpenCode supervisor or API proxy before ACP parity exists.
- Translating native harness configuration into a lowest-common-denominator schema.
- Adopting Sandbox Agent's universal REST schema, persistence model, or SDK.
- Dynamic adapter installation during a user request.
- Pretending every harness supports the same models or authentication mechanisms.

## Verification gates

- A real child process handles `initialize`, `session/new`, prompt streaming, and client responses over HTTP/SSE.
- Signed auth is required on every ACP route.
- Mismatched harness reuse is rejected.
- SSE reconnect replays only events after `Last-Event-ID`.
- Deleting a server terminates the child and is idempotent.
- Claude and Codex adapter binaries start in the actual sandbox image and complete `initialize` plus `session/new` with real credentials before the runtime is called production-ready.
