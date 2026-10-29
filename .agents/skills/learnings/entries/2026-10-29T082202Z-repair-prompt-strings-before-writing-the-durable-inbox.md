---
recorded: 2026-10-29T08:22:02Z
incident_date: 2026-10-29
---
# Repair prompt strings before writing the durable inbox

**Rule:** Apply the existing jsonbSafeValue repair before flattening and measuring caller-supplied prompt parts.

**Trigger surface:** Prompt submission, pending prompts, and prompt edits that enter the durable inbox.

**Incident:** On 2026-10-29, KRTX-3647 found 15 prompt requests returning 500 with SQLSTATE 22P05. PostgreSQL rejected U+0000 in JSON strings. The prompt sanitizer retained those strings.

**Enforcement:** apps/api/src/projects/session-lifecycle/prompt-parts.test.ts asserts repair of NUL and lone surrogates, including nested source keys, while retaining valid Unicode.
