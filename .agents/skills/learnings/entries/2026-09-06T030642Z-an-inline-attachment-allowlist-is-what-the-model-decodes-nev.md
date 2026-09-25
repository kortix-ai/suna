---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# An inline attachment allowlist is what the model DECODES, never a MIME prefix

**When:** deciding whether a file part rides inline (base64) or is written to
the box. `image/*` is not a decodability test. OpenCode decodes every `image/`
part before it persists the message, so one undecodable type throws
`ImageDecodeError` inside `prompt_async` and NO message is written — the prompt
text and every sibling attachment are deleted with it. `prompt_async` answers
204 for *accepted*, so the inbox row still records `delivered` and nothing
retries or surfaces. *Incident:* two SVG logos + a PDF from the session
composer; the whole turn vanished, transcript showed only a spinner, DB said
`succeeded`. `image/svg+xml`, `bmp`, `x-icon`, `heic`, `heif` are all in the
composer's own upload allowlist. *Enforcer:* `prompt-attachments.test.ts`
(allowlist + parameter stripping), `prompt-attachment-materializer.test.ts`
("materializes image types the model cannot decode"), `user-message.test.tsx`
("renders the undecodable-image batch that used to delete the message").
*Open:* delivery still has no read-back proof — a runtime-side throw is still
recorded as `delivered`.
