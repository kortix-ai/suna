Faster sessions, resilient multimodal runs, and safer previews

## Sessions

- Sessions start faster with OpenCode 1.18.19, leaner runtime assets, reusable Git bundles, and guarded image preparation.
- Existing sessions recover after sleep, runtime loss, dropped streams, and interrupted connections.
- Transcripts catch up after missed events, render long threads sooner, and load attachment bytes only when needed.
- Unsent drafts persist per project and session. The composer can reference recent session files from the `/` menu.
- Fixed duplicate prompts, stale status snapshots, malformed runtime responses, and inaccessible backend-origin sessions.

## Product experience

- Every sandbox preview port can use its own origin across cloud and self-hosted deployments.
- ZIP archives can be browsed and extracted in the file viewer.
- The CLI now covers models, sessions, agents, connectors, triggers, access, billing, reviews, and project settings.
- Added ranked command-palette results, a resizable sidebar, clearer change indicators, a rebuilt Apps gallery, and a simpler Customize chooser.
- Retired the experimental voice runtime and its unused product surfaces.

## Security and reliability

- Preview origins enforce trusted CORS, cross-site write protection, read-only shares, immediate revocation, and host-scoped cookies.
- Sandbox credentials stay confined to their session. Connector-bound secrets receive tighter delivery boundaries.
- Experimental network-enforced secrets support streaming bodies, Server-Sent Events, large payloads, and credential substitution in authorization and cookie headers.
- Paid legacy subscriptions pass the wallet floor correctly and receive renewal credits based on actual payments.
- The LLM gateway handles large image requests without repeated base64 copies and survives overload without process crashes.
- Gateway and edge failures return structured retryable errors instead of intermediary HTML or invalid compressed bodies.
- Audit writes no longer block API traffic. Audit reads use bounded barriers under continuous traffic.
- Added database connection limits, secret-write coalescing, per-project session controls, safer live-turn reaping, and initial-prompt replay protection.
