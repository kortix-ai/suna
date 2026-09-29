Connect your own computer from the desktop app, Teams at Slack parity, and saved history that is always on.

Connect your own computer from the desktop app, Teams at Slack parity, and saved history that is always on.

## New

- Local mode: connect your computer from the desktop app. Each computer is a connector account with access approval, and the tunnel keeps running in the background while the app is closed.
- Microsoft Teams reaches Slack parity: direct messages, a connected note, a home tab, message actions, edit and delete, `/unbind`, `/status` buttons, `/sessions`, the full agent picker, review cards, and call-to-action links as buttons.
- Saved session history is always on, and a reload shows the newer saved copy.
- Mobile: an empty session opens on its composer, messages queue while the computer wakes, and sub-agents show their saved steps.
- A redesigned Create a project page. New accounts get their name during onboarding, not from the email address.
- Sessions list as a tree that shows who started each run, with server-side search.
- Copy a session ID or link from the session menu.

## Improved

- The desktop app reopens your last project on launch, the same as the web.
- Connect-computer approval is a dialog you can close.
- A ChatGPT login the provider refuses is refreshed, and the message says who can reconnect it.
- Session overrides open while their catalog loads; Save commits what is ready.
- An agent-created session saves its transcript at every turn end.
- Audit ingest answers within the request deadline.
- Transcript reads and gateway resolution do less work per request.
- MCP `list_projects` returns the caller's project role.

## Fixed

- Prompt attachment imports keep the sender's access.
- Computer access and machine states return 4xx errors, not 500.
- Repository previews in channels show only public repositories.
- The Composio Microsoft Teams app is hidden; Teams is a native channel.
- The public health endpoint no longer exposes internal deployment details.
- A malformed preview cookie is refused, and playground budget denials are typed.

