Connect Slack and email in place, fix inbound email, and steadier live previews

**New**
- Connect Slack and email channels directly from the project view — set them up in place without leaving the page.
- "Fix with agent" on a change request: when a merge is blocked by a manifest conflict, hand it to the agent to resolve it.

**Fixed**
- Inbound email now reaches your agent. The AgentMail webhook endpoint had been dropped from the API, so replies to your agent's emails never started a session — restored it, along with the Slack identity-bind endpoint that was dropped with it.
- Live preview proxy now caps its retry budget under the load-balancer idle timeout, so slow previews fail fast instead of hanging.
