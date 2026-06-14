ChatGPT subscription login, steadier Slack, and a Skills file tree

## New
- **Connect your ChatGPT Plus/Pro subscription.** Sign in once from a project's provider settings — or from the CLI with `kortix providers login openai` — and every session reuses it, no API key needed. It uses OpenAI's device login and stores the resulting credential encrypted, per project.
- **Skills tab is now a real file tree.** Browse a project's skills as a navigable, recursive tree.

## Improved
- **Slack is steadier.** Agent questions no longer block a turn, so threads don't get stuck; a Slack thread now maps permanently to a single session that brings its own sandbox back as needed; and the flaky streaming widget was retired.
- **Executor accepts YAML OpenAPI specs**, with hardened spec parsing.
- **CLI agents reach full programmatic parity**, including parallel sub-agent orchestration.

## Under the hood
- More API memory headroom (dev + prod) so the new ChatGPT device login can't exhaust a pod.
- Dev cluster tuning for low traffic (autoscaling and pod-disruption-budget adjustments).
