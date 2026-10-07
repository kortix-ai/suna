Steer a running turn, live queue state, and spend by source

## New

- **Steer a running turn.** A message sent with Enter while the agent works reaches the running turn at its next step, and the turn does not stop. The message waits above the composer as "Read at next step". Cmd/Ctrl+Enter still queues a message for after the turn, and a queued message has a "Stop and send" action. The CLI has `kortix sessions chat --steer`.
- **Live queue state.** The queue above the composer updates from the session stream instead of a once-a-second poll.
- **Spend by source.** LLM credit usage shows which trigger, member or caller spent it.
- **Trigger templates** can use `cron.scheduled_date` and `cron.scheduled_hour`.
- **CLI:** `kortix validate` warns about large repositories, and `kortix ship` runs it first.
- **New skill form:** a skill can be created from a form without a model.
- The new-project handoff shows each provisioning step as it happens.

## Improved

- A ChatGPT connection that reached its plan limit is tried again after 15 minutes, and its owner can retry it at once.
- pi compacts the conversation at a token budget instead of at the model's full window.
- A sandbox that cannot start because the provider's storage quota is full says so.
- A slow session restore shows as waiting, not as stalled or failed.
- A scheduled account deletion now runs when it is due. It removes the account's data and login, cancels the subscription and stops the sandboxes.
- Members no longer see Restart, Stop or Delete on sessions they cannot control. A manually fired trigger is labeled as manual.

## Fixed

- YAML and JSON files preview again.
- A 401 makes every app fetch a fresh token.
- Usage metering closes gaps where a stream could go unbilled, and refunds are clawed back correctly.
- Monthly renewals keep credit balances to the full four decimals.
- An "Only you" secret stays private when its holder's role or group changes.
- Only live account tokens are listed, and a 401 from a revoked token names it.
- Security hardening: tenant isolation for invites, usage and setup links, agent app preview isolation, MFA step-up, and sandbox proxy access checks.
- The API finishes in-flight work on shutdown and retries webhooks until they are acknowledged.
- CLI fixes for `projects link --host`, `approvals ls` and change requests.
- Slack and Teams file downloads stay inside the project.
- An approval request sends one notification, not one per server.
- A change to who can use a secret or a connected account applies on every server at once.
