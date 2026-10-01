Session labels, a redesigned approval flow, and long sessions that compact instead of failing.

Session labels, a redesigned approval flow, and long sessions that compact instead of failing.

## New

- Sessions carry writable labels and metadata across the API, SDK, CLI, MCP and web, and the session list filters by label.
- Redesigned approval, preview and install consent screens.
- A split "Connect your computer" dialog with one-click CLI copy.
- Recent session views stay open across project navigation; the command palette finds sessions by ID.
- The desktop app copies the current session URL from the Go menu and reports sanitized crash telemetry.
- Push notifications route by browser presence: a session open in a tab does not also push.
- Project-bound agents get their own cost rollups.
- `kortix apps access --viewer`, and the CLI lints manifest wiring references.
- The pi harness loads repository-native Pi configuration and supports config releases.
- Each agent's OpenCode plugins load in isolation.
- Sign in to OpenCode Go with your OpenCode account from a sign-in card, instead of pasting a key; each provider now has its own key name.
- Connector discovery is on by default for every project.
- Choose who can use a secret's value: only you, everyone, or chosen people and groups.
- Manifest v3: agents boot from `kortix.yaml`.

## Improved

- Managed models can write up to 65,536 output tokens; the ChatGPT lineup and provider defaults come from live data.
- A session whose sandbox lacks the model a turn asks for is repaired, for any provider.
- Audit reconciliation is incremental, which cuts database load.
- Session pages prefetch on intent, and a revived stream rehydrates the transcript.
- Long managed sessions compact instead of failing at the model's context window; new sessions boot with the current managed context limit.
- The session scope view reads the cached repository instead of waiting for a git fetch.
- Stop answers within the request deadline and reports `stopping` while the sandbox finishes shutting down.
- Creating a project retries the first push while GitHub finishes creating the repository, instead of rolling back.
- Agent config from the base branch reaches a session on reload, even without config releases.
- A session restored from an archived sandbox gets up to 12 minutes to wake instead of failing at 8.
- Mobile queues prompts in the server inbox, and a turn that ended while the stream was down goes idle.
- New users land on the project selector.
- Neutral runtime names across the API, SDK and CLI (OpenCode decoupling).

## Security

- Dependency updates close a critical Next.js vulnerability and eight high-severity ones (axios, undici, fast-uri, js-yaml, brace-expansion, @xmldom/xmldom, path-to-regexp, @grpc/grpc-js).

## Fixed

- A malformed access request answers 400 instead of 500.
- Reminder trigger sessions open themselves, with atomic caps.
- App viewer tokens no longer fail with 401 after an access-policy save, and no longer appear in App logs.
- Account API keys are refused before session daemon access; the session token acts as the person who starts each turn.
- Slack replies to a bound session return to the thread they came from; Slack writes stay inside the calling project's channels and threads; an unavailable model stops before a Slack thread starts.
- Listing or sharing connectors, or disconnecting a computer, no longer fails with 500 on a database deadlock.
- An agent cannot be switched while its session is running; overlapping turns keep the running state.
- A failed secret save keeps the form's contents.
- Sessions on a sandbox owned by another API instance refuse prompts instead of racing it.
- Agent `.md` model references resolve through the Kortix provider in gateway mode.

