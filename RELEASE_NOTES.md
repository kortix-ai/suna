Trigger run history, a bigger Free plan, and steadier sessions

### New
- **Trigger run history.** Every trigger keeps a list of its runs with status, error and end time. You can test-fire a trigger with a payload, replay a past run, and missed cron slots are bounded.
- **More credit tiers and larger top-ups.** The Free plan now includes 500 credits and the managed models.
- **DeepSeek V4.1 Flash** now serves the 1017 snapshot on Morph (US region, zero data retention).
- **Subprocessor notices.** The subprocessor list is published, and owners and admins of paid accounts get a 30-day email notice before a new subprocessor takes effect.
- **White-label license.** A free, self-serve white-label license is published next to the repository license (`WHITE-LABEL-LICENSE.md`).
- **Customize › Agents** lists agents first, with subagents in their own section.
- **Kortix Capture:** choose an Exclusion or Inclusion policy, categories list what they cover, the cloud policy applies from the first frame, and the app has Restart and Quit.

### Improved
- Provider failures recover better: internal continuations, one terminal error row, suggestions you can act on, and a cancel you made yourself no longer shows as a model failure.
- Model-switch errors stay in the conversation history.
- Sign-in and password recovery by email are more reliable. Refused auth emails show an honest message, and the link buttons cool down.
- The CLI resolves the host and the default project the same way everywhere, keeps its identity inside a delegated sandbox, routes help correctly, and reports billing in the same credit units as the wallet.
- Connectors: the sync summary agrees with the list, `policy ls` shows connector rules, and the All tab lists the project's own connectors.
- API keys: revoked gateway keys are hidden, a create cannot mint twice, and revoked personal keys can be deleted (also from the CLI).
- `/new` shows the plan cap before the first failed create.
- Phone layouts on web and mobile have accessible navigation targets.
- Platinum images for US-region projects are built and copied in their region, so the first session after a template rebuild does not wait.
- Sessions start faster: env-sync no longer blocks `/start` on the model push and no longer pushes into stopped boxes.
- An opened App scrolls at once, and its bar is Refresh, Open, Settings and Close. App releases run on Platinum when it is configured.
- "Open as admin" acts as the project's account.
- Sandboxes clear known-safe caches when their disk fills up.

### Fixed
- Shared session start failures retry.
- The auth callback logs provider errors safely.
- Dead public share links show the unavailable page.
- Streaming markdown keeps its blocks around fenced definitions.
- A provision stream that closes mid-way recovers its real result; 502/503 alerts show the real reason.
- App locales are no longer double-prefixed.
- Onboarding promos stay dismissed and no longer stack after you exit the wizard.
- A future key expiry shows as a countdown.
- The agent config and model pins reject an agent name that is not declared.
- LLM inference refuses principals that have no project (`403 project_required`).
- Subscription plan resolution ignores enterprise metadata hints.
- Many smaller fixes across web, mobile, the CLI, the whitelabel demo, the gateway and the API.
