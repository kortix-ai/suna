Durable prompt delivery, reliable sandboxes, faster projects, and resilient terminals

### New

- **Host-centric CLI authentication.** The CLI organizes credentials as Host → Account → Project → Session. It supports multiple Kortix hosts and never sends credentials over remote HTTP.
- **Project-wide session inventory.** Project managers can list every session in a project, including sessions that other members started.
- **Conversation-aware triggers.** Triggers can create, reuse, or pin sessions per conversation. Delivery filters and custom headers give each trigger explicit routing controls.
- **Session origin tracking.** Sessions record whether a user, trigger, schedule, backend credential, or system process started them. Backend credentials can attach a validated `origin_ref`.
- **Standard LaTeX delimiters.** Chat renders parenthesized inline LaTeX and bracketed display LaTeX. Code spans and code blocks preserve delimiter-like text.

### Improved

- **Durable prompt delivery.** Trigger deliveries survive restarts. Dead letters surface failures and self-heal. A reconciler re-delivers prompts that fail in flight. Messages entered during provisioning wait until the computer is ready.
- **Faster project and session loading.** Session reads no longer block on sandbox title synchronization. The frontend uses the lightweight project access route and polls healthy sidebars less often.
- **Bounded terminal recovery.** Terminal reconnection has finite retries and explicit readiness handling. Broken PTY connections no longer retry without a bound.
- **Explicit model routing.** Every explicit model override uses the Kortix gateway when the gateway is active. Native provider routing remains unchanged when the gateway is disabled.
- **Correct out-of-credits UX.** The top-up modal shows the live balance. Checkout returns to a valid URL. The modal uses the product design system. Successful top-ups show a toast and reduced-motion-safe confetti.
- **Clearer documentation.** The documentation now follows user journeys and uses Simplified Technical English. The API key page includes a backend API example.

### Fixed

- **Sandbox rebuild loops and Daytona rate limits.** Warm image builds are paced per project and provider. Concurrent deploys cannot delete a fresh image. Provider rate limits now use retries.
- **Origin and request validation.** Backend session overrides require trusted credential types. Bun requests without a Host header no longer fail path parsing.
- **Soft-deleted keyed sessions.** Trigger session lookup no longer binds a conversation key to a soft-deleted session.
- **Operations and error tracking.** Large audit logs no longer break the operations overview. Expected browser, WebView, model-state, and transient provider errors no longer create Sentry noise.
- **Security dependencies.** This release updates axios, Hono, SVGO, DOMPurify, Pillow, GitHub Actions, and related transitive dependencies.
