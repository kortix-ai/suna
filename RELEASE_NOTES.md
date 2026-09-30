Every kortix CLI command over MCP, connectors as MCP tools, and US-region sessions.

Every kortix CLI command over MCP, connectors as MCP tools, and US-region sessions.

## New

- The hosted MCP server reaches full `kortix` CLI parity through a sandboxed `kortix` tool, and serves project skills.
- Connectors are first-class MCP tools.
- Projects can run their sessions in the US East region.
- A GDPR-complete privacy policy and a public subprocessors page at /legal/subprocessors.

## Improved

- GLM 5.3 Flash is served from OpenCode Zen first, with the OpenRouter pool as fallback.
- Slack channels have defaults, and Teams and Slack permissions cover roles, identity links, join policies, and the bot's own scope.
- MCP OAuth refresh tokens get a grace period, a sweeper, and code-reuse revocation. Reads after a push return fresh data.

## Fixed

- A session that was open across a deploy keeps accepting prompts. A runtime restart no longer ends a turn it already accepted, and every turn end reaches the API.
- A live session no longer goes to sleep after a short network interruption.
- A session whose sandbox lost its OpenCode root pin resumes the right conversation.
- A pi model that stops responding ends with a visible timeout.
- Deleting a user revokes their API tokens, OAuth tokens, and pending authorization codes.

