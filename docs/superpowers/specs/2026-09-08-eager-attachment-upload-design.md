# Eager composer attachments

## Problem and decision

Uploads currently start at Send. Pasting, dropping, or selecting a file must start its upload immediately, independently of session readiness. Jay explicitly requested implementation on September 8; this supersedes the September 7 spec-only gate.

Use project-scoped private storage behind the authenticated API. Keep upload transport and state in `@kortix/sdk`. The composer displays that state. Both first prompts and running-session prompts submit attachment identifiers, not file bodies. Do not merge `main` without explicit approval.

## Contract

- Shared limits: 50 MiB per file, 100 MiB per message, 20 files. Enforce actual received bytes on the server and validate authoritative stored sizes at Send.
- Start uploads when files enter the composer through paste, drop, or picker. Do not wait for Send, runtime readiness, or a session identifier.
- Show pending/progress, completed, and failed states on each tile. Failed tiles offer Retry. Removing a pending tile cancels its upload. Send stays disabled while a tile is pending or failed. Keyboard submission uses the same gate.
- Server-minted opaque identifiers identify private objects. Bind ownership to account, project, and uploader. Reject foreign, expired, incomplete, duplicate, and oversized references before accepting a prompt.
- Link attachments to lifecycle commands transactionally in all three paths: create session, claim warm session, and enqueue follow-up. Queued, forwarded, retrying, and dead-lettered commands retain their attachments. Use references rather than one-shot claims so an attachment can be reused within its authorized project.
- Unreferenced uploads expire after 24 hours. Delete expired/unneeded objects before their metadata. Coordinate cleanup with reference binding so cleanup cannot delete a newly queued attachment. Do not delete historical prompt bodies as part of this change.
- Materialize references at deterministic command-scoped workspace paths. A capable daemon pulls an API-issued short-lived storage URL, verifies size/digest, writes a temporary file, then renames it. Older daemons use the existing bounded upload compatibility path. Never accept an arbitrary client-provided download URL.
- Preserve native-image behavior and the existing inline budget. Durable inbox payloads contain attachment identifiers, never the new upload's base64 body. Keep existing clients' data-URL prompts compatible.
- Drafts must not persist local blob URLs, File objects, credentials, or signed URLs. Persist completed handle metadata only when safe under the existing user-bound draft contract; otherwise keep files memory-only and state the limitation.

## Verification

Use failing tests before implementation. Exercise actual authenticated routes and persisted command payloads. Drive the real composer and prove the upload request occurs before Send for paste, drop, and picker. Verify first-session and existing-session paths, progress/error/retry/remove, message limits, sleeping runtime independence, and no repeated upload at Send. Run SDK gates, focused API/daemon/web tests, type/lint/brand checks, and the full preview at the final branch head. Keep PR #7148 draft; report preview proof and outstanding merge approval separately.
