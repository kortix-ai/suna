Faster, more reliable sessions + PDF/PPTX viewers + security hardening

**Sessions — unified, more reliable startup.** Opening a session now runs through one server-driven endpoint that provisions, resumes, and connects the workspace in a single call, with a clean staged "Kortix Computer is starting" loader. Fixes the intermittent "stuck spinner until a hard refresh," removes a stale git-lock failure that could block session creation, and makes the connect flow predictable. Verified end-to-end on dev (project + session CRUD, repeatable cold starts ~17s).

**Files.** File reads now go through the sandbox daemon; the PDF and PPTX viewers were rebuilt.

**Security.** Session visibility is now enforced on the sandbox proxy daemon port, not just account membership.

**Reliability.** Warm-pool boxes that errored are swept automatically; pool boxes boot on the reliable region.

**Integrations.** Slack app expanded to 57 bot scopes with the AI Assistant enabled.
