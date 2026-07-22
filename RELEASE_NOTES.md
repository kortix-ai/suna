Reliable sandbox builds, durable prompt delivery, and WhatsApp (experimental)

### New

- **WhatsApp (experimental)** — connect WhatsApp as a channel: a real connect flow, messaging tools, profile display, and per-conversation sessions. Enable it under experimental features.
- **Smarter triggers** — triggers can key sessions per conversation (fresh, reused, or pinned), filter which deliveries fire, and send custom headers.
- **CLI: host-centric auth** — the CLI now organizes everything as Host → Account → Project → Session, so you can sign in to several Kortix instances and switch between them. Remote HTTP hosts are normalized to HTTPS, and credentials are never sent over plain HTTP.
- **Project session inventory** — project managers can list every session in a project, including sessions started by other members.

### Improved

- **Prompt delivery is durable.** Trigger deliveries survive restarts, failed deliveries surface loudly and self-heal, and a reconciler re-delivers prompts lost mid-flight. Messages typed while a computer is still provisioning are queued and delivered when it is ready.
- **Sessions record their origin.** Every session now tracks what started it — the web app, the CLI, a trigger, or a backend API call — consistently, including in-sandbox executor and queued backend creates.
- **Docs rebuilt** — the documentation is restructured around user journeys and rewritten in Simplified Technical English.
- The API-keys page explains how to use Kortix as a backend over REST.
- Owner-scoped connector profiles bind at session start, with tighter rules for who can hold a member profile.

### Fixed

- **Sandbox templates no longer rebuild in a loop.** Warm image builds are paced per project and provider, a freshly built image can no longer be deleted by a concurrent deploy, and provider rate limits are retried instead of failing the build. This also stops the Daytona API rate-limit storms.
- Team accounts that run out of credits now see a top-up option instead of the Free-plan upgrade pitch.
- Keyed trigger sessions no longer bind to a soft-deleted session.
- The ops overview no longer fails on large audit logs, and error tracking is quieter: browser-extension noise, WebView bridge errors, and transient provider failures are classified out.
- Security dependency updates across the board (axios, hono, svgo, dompurify, pillow, and more).
