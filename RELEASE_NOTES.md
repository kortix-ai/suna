Reliable projects, durable sessions, and security hardening

### New

- **Host-centric CLI authentication.** The CLI organizes credentials by host, account, project, and session. Remote HTTP hosts normalize to HTTPS.
- **Project-wide session inventory.** Project managers can list every session in a project.
- **Conversation-aware triggers.** Triggers can create, reuse, or pin sessions per conversation. Delivery filters and custom headers provide explicit routing controls.
- **Session origin tracking.** Sessions record whether a user, trigger, schedule, backend credential, or system process started them.
- **Agent discovery.** Kortix publishes RFC 8288 links, API and MCP catalogs, OAuth metadata, auth.md, Agent Skills, Markdown negotiation, Content Signals, WebMCP tools, and a read-only public documentation MCP server.
- **Standard LaTeX delimiters.** Chat renders parenthesized inline LaTeX and bracketed display LaTeX while preserving code spans and blocks.

### Improved

- **Durable prompt delivery.** Deliveries survive restarts. Dead letters self-heal. A reconciler re-delivers prompts lost in flight. Messages entered during provisioning wait for readiness.
- **Faster project and session loading.** Session reads no longer block on sandbox title synchronization. The web app uses the lightweight project-access route and reduces healthy-sidebar polling.
- **Bounded terminal recovery.** Terminal reconnection uses finite retries and explicit readiness handling.
- **Explicit model routing.** Explicit model overrides use the Kortix gateway when the gateway is active. Native provider routing remains unchanged when it is disabled.
- **Correct out-of-credits UX.** The top-up modal shows the live balance and uses a valid checkout return URL.
- **Clearer documentation.** Documentation follows user journeys and uses Simplified Technical English.
- **Reliable release verification.** Release gates use current staging API contracts, explicit funding requirements, managed model selection, bounded provisioning timeouts, and host-scoped CLI authentication.

### Fixed

- **Project-page crash.** Project access queries use an isolated cache key and no longer read `.length` from an unrelated or undefined query result.
- **Duplicate prompt delivery and status labels.** Prompt delivery uses idempotency keys, avoids ambiguous retries, and reports active session work accurately.
- **Sandbox rebuild loops and provider rate limits.** Warm image builds are paced and concurrent deploys cannot delete a fresh image. Provider rate limits use bounded retries.
- **Agent discovery headers.** Middleware preserves separate discovery and preload Link fields.
- **Critical and high security findings.** The release resolves all open critical and high CodeQL and Trivy findings. It adds EKS secrets encryption, KMS policy, ALB invalid-header dropping, VPC flow logs, and focused validation hardening.
- **Security dependencies.** Next.js is 15.5.21, fast-uri is 3.1.4, sharp is 0.35.0, and fast-xml-parser is 5.10.1. The release also updates Axios, Hono, SVGO, DOMPurify, Pillow, GitHub Actions, and related transitive dependencies.
- **Legacy code removal.** The unused mobile AgentPress shared package and two dead API scripts are removed.
- **Origin and request validation.** Backend overrides require trusted credential types. Bun requests without a Host header no longer fail path parsing.
- **Soft-deleted keyed sessions.** Trigger lookup no longer binds a conversation key to a soft-deleted session.
- **Operations and error tracking.** Large audit logs no longer break the operations overview. Expected browser, WebView, model-state, and transient provider errors no longer create Sentry noise.
