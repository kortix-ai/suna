Reliable projects, backend sessions, and security hardening



### New

- **SEO Department marketplace project.** A preconfigured SEO team provides content strategy, SERP analysis, technical audits, repository monitoring, skills, and validated marketplace navigation.

- **Backend session controls.** The API, SDK, and CLI support model overrides, `origin_ref`, allowlisted secrets, connector bindings, and context. Session responses expose origin and allowlist state.
- **Host-centric CLI authentication.** The CLI organizes credentials by host, account, project, and session. Remote HTTP hosts normalize to HTTPS.
- **Project-wide session inventory.** Project managers can list every session in a project.
- **Conversation-aware triggers.** Triggers can create, reuse, or pin sessions per conversation. Delivery filters and custom headers provide explicit routing controls.
- **Session origin tracking.** Sessions record whether a user, trigger, schedule, backend credential, or system process started them.
- **Agent discovery.** Kortix publishes RFC 8288 links, API and MCP catalogs, OAuth metadata, auth.md, Agent Skills, Markdown negotiation, Content Signals, WebMCP tools, and a read-only public documentation MCP server.
- **Standard LaTeX delimiters.** Chat renders parenthesized inline LaTeX and bracketed display LaTeX while preserving code spans and blocks.

### Improved

- **Durable prompt delivery.** Deliveries survive restarts. Dead letters self-heal. A reconciler re-delivers prompts lost in flight. Messages entered during provisioning wait for readiness.
- **Bounded session synchronization.** Web and mobile session synchronization uses bounded SDK controllers, preserves project navigation, and avoids redundant listeners and requests.
- **SDK cold-start readiness.** `ensureReady()` polls through sandbox startup and caps each wait to the remaining deadline.
- **Faster project and session loading.** Session reads no longer block on sandbox title synchronization. The web app uses the lightweight project-access route and reduces healthy-sidebar polling.
- **Bounded terminal recovery.** Terminal reconnection uses finite retries and explicit readiness handling.
- **Explicit model routing.** Explicit model overrides use the Kortix gateway when the gateway is active. Native provider routing remains unchanged when it is disabled.
- **Correct out-of-credits UX.** The top-up modal shows the live balance and uses a valid checkout return URL.
- **Clearer developer documentation.** The Kortix-as-a-Backend guide covers API, SDK, and CLI usage with connector and secret security semantics.
- **Reliable release verification.** Release gates use current staging API contracts, explicit funding requirements, managed model selection, bounded provisioning timeouts, and host-scoped CLI authentication.
- **Transient release-gate resilience.** Project provisioning retries marked network errors, HTTP 5xx responses, and explicit rate limits. Session readiness retries transient failures and allows longer sandbox startup.

- **Staging database stability.** Staging API workers cap each database pool at four connections across EKS and ECS.
- **Git mirror refresh resilience.** Branch-ahead resolution forces one mirror refresh when a new session branch is absent from a warm mirror. Persistent missing refs and authentication failures remain fatal.

### Fixed

- **Project-page crash.** Project access queries use an isolated cache key and no longer read `.length` from an unrelated or undefined query result.
- **GitHub App installation reuse.** Project creation finds and links existing GitHub App installations across the API, SDK, web app, and end-to-end route contract.
- **Project session authorization.** Project-wide session inventory requires `project.session.read` before the API queries or returns sessions.
- **Duplicate prompt delivery and status labels.** Prompt delivery uses idempotency keys, avoids ambiguous retries, and reports active session work accurately.
- **Sandbox rebuild loops and provider rate limits.** Warm image builds are paced. Concurrent deploys cannot delete a fresh image. Provider rate limits use bounded retries.
- **Agent discovery headers.** Middleware preserves separate discovery and preload Link fields.
- **Critical and high security findings.** The release resolves all open critical and high CodeQL, Trivy, and Dependabot findings. It adds EKS secrets encryption, KMS policy, ALB invalid-header dropping, VPC flow logs, and focused validation hardening.
- **AWS audit and recovery controls.** CloudTrail uses KMS encryption, CloudWatch Logs, SNS delivery, and log-file validation. Backup selections and the existing recovery-point vault remain intact.
- **Security dependencies.** Next.js is 15.5.21, `fast-uri` is 3.1.4, `@hono/node-server` is 2.0.10, `sharp` is 0.35.0, `fast-xml-parser` is 5.10.1, and PostCSS is 8.5.16. This resolves CVE-2026-45623. The release also updates Axios, SVGO, DOMPurify, Pillow, GitHub Actions, and related transitive dependencies.
- **Legacy code removal.** The unused mobile AgentPress shared package and two dead API scripts are removed.
- **Current starter contract coverage.** API tests assert the current `general-knowledge-worker` default and current starter repository contents.
- **Current infrastructure lint metadata.** Release checks use TFLint 0.64.0 and AWS ruleset 0.48.0 to validate supported Lambda Python 3.13 runtimes.
- **Origin and request validation.** Backend overrides require trusted credential types. Bun requests without a Host header no longer fail path parsing.
- **Soft-deleted keyed sessions.** Trigger lookup no longer binds a conversation key to a soft-deleted session.
- **Operations and error tracking.** Large audit logs no longer break the operations overview. Expected browser, WebView, model-state, and transient provider errors no longer create Sentry noise.
