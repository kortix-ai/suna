Reliable LLM completions, plus sandbox and gateway fixes

## Fixed
- The LLM gateway no longer returns a blank, empty reply when a model provider silently produces nothing (a rare but real upstream failure mode). It now retries the same provider a few times, then fails over to another configured provider if one is available, before ever giving up — so a transient provider hiccup resolves invisibly instead of showing up as an empty response.
- The gateway strips stray NUL bytes from request/response logs before saving them, avoiding an occasional database error that could drop a log entry.
- Fixed a case where the first message of a new session could fail right after an environment restart, instead of waiting for the runtime to come back up.
- Made the internal migration step idempotent so it no longer depends on which pod happens to run it.
- Narrowed an account-membership repair path to be safer and more precise.

## Improved
- Platform admins get read-only access to the project access gate for support/investigation, without full write access.
- Projects can now override which sandbox provider they use on a per-project basis.
- Slack identity verification is now enabled on staging, matching production.
- Handle AgentMail inbox-limit errors gracefully instead of surfacing a raw failure.
