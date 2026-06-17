Slack webhook reliability and unified invocation engine

**Slack** — fixed the dev/prod stuck-hourglass path by shipping the Slack schema/runtime hotfix and preserving canonical + bring-your-own webhook parity.

**Invocation lifecycle** — reapplied the unified session invocation engine so Slack, manual triggers, cron, webhooks, CLI, mobile, and web session creation share the same durable lifecycle path.

**Triggers** — webhook/manual/cron trigger fires now use durable queued invocation semantics under backpressure and record accepted queued fires in trigger runtime state.

**Verification** — dev API is serving `0.9.57-dev.845b5eda`; `/v1/health` sampled cleanly; Slack canonical route rejects unsigned requests with 401; BYO manifest emits production/dev API webhook URLs correctly; trigger E2E and API typecheck passed before merge.
