GLM 5.2 in the model picker, a cleaner Slack connect flow, and reliability fixes

**New**
- **GLM 5.2 is now selectable directly** in the model picker; the "Auto" model sits behind a flag.
- **Slack connect and request-access are separate steps now** — connect right in a thread, and request access without being pushed through a connect flow first.
- **Slack access nudges** arrive as a DM and an in-thread notice so they're harder to miss.
- **Agents no longer stop while they still have open to-dos** — an always-on continuation check keeps a run going until its to-do list is actually finished.

**Fixed**
- The file viewer now opens dot-directories like `.opencode`.
- Free-tier and native Zen free-model availability resolve correctly in the model picker.
- OAuth and other backend redirects pass straight through to the browser instead of being swallowed — no more blank page on some connect flows.
- AgentMail inbox-limit errors are handled gracefully instead of failing the request.

**Behind the scenes**
- Release and staging CI plumbing: Vercel SSO bypass so the staging release gate runs end-to-end, and removal of the direct prod-hotfix workflow in favor of the staging-only promotion path.
