## Anthropic auth plugin vs Claude Code

### Files inspected
- `/Users/vukasinkubet/dev/comp/.opencode/plugin/kortix-system/auth.ts`
- `/Users/vukasinkubet/dev/claude-code/src/constants/oauth.ts`
- `/Users/vukasinkubet/dev/claude-code/src/services/oauth/index.ts`
- `/Users/vukasinkubet/dev/claude-code/src/services/oauth/auth-code-listener.ts`
- `/Users/vukasinkubet/dev/claude-code/src/services/oauth/client.ts`
- `/Users/vukasinkubet/dev/claude-code/src/utils/auth.ts`
- `/Users/vukasinkubet/dev/claude-code/src/utils/http.ts`
- `/Users/vukasinkubet/dev/claude-code/src/services/mcp/claudeai.ts`
- `/Users/vukasinkubet/dev/claude-code/src/services/api/filesApi.ts`

### How Claude Code works
1. It starts a localhost callback server and generates PKCE + state.
2. It builds two auth URLs:
   - automatic localhost callback flow
   - manual callback flow via `https://platform.claude.com/oauth/code/callback`
3. For Claude.ai login it requests the full scope set, not just `user:inference`:
   - `user:profile`
   - `user:inference`
   - `user:sessions:claude_code`
   - `user:mcp_servers`
   - `user:file_upload`
   - plus Console scope when needed (`org:create_api_key`)
4. After token exchange it fetches/stores profile + org/account metadata and uses scopes to determine capability.
5. On refresh, Claude Code deliberately allows scope expansion for Claude.ai users by omitting explicit scopes or defaulting to the full Claude.ai scope set.
6. Runtime auth selection disables first-party Anthropic OAuth when the session is truly using third-party auth (Bedrock/Vertex/Foundry or external API-key sources in many contexts).
7. API requests use Bearer auth plus `anthropic-beta: oauth-2025-04-20`; extra beta headers are added for files/MCP/session endpoints.
8. It retries once on auth-related 401s after forced token refresh.

### Current comp plugin behavior
- Separate auth methods:
  - `Claude Pro/Max` requests only `user:inference`
  - `Create an API Key` requests the broader Console scopes
- No localhost callback listener; user manually pastes the redirect URL/code.
- Refresh path always requests only `user:inference`.
- No profile/org/account fetch/store.
- No auth-mode detection equivalent to Claude Code's `isAnthropicAuthEnabled()` / `getAuthTokenSource()` / `isUsing3PServices()`.
- No 401 retry path after refresh failure.

### Most important divergence / likely root cause
The current `Claude Pro/Max` login path in `comp` is too narrow. It requests only `user:inference`, while Claude Code requests the full Claude.ai scope set and relies on those scopes for first-party capability detection and privileged endpoints like Claude Code sessions, MCP servers, and file upload.

That means the plugin is not reaching Claude Code-equivalent auth level. Even if inference works, anything expecting real Claude Code / Claude.ai subscriber semantics can degrade, be misclassified, or fail with behavior that looks like a "third-party" path.

### Concrete gaps to close if we want Claude Code parity
1. Change Claude.ai/Pro/Max auth to request full Claude.ai scopes, not only `user:inference`.
2. Change refresh to preserve/expand Claude.ai scopes like Claude Code does.
3. Store scopes and optionally account/org/profile metadata after exchange.
4. Add auth-mode selection logic so external API-key / third-party-provider scenarios do not masquerade as first-party OAuth.
5. Add a localhost callback listener + manual fallback to match Claude Code UX and CSRF/state handling.
6. Add endpoint-specific beta headers where needed (`files-api`, MCP, etc.).
7. Add 401 forced-refresh retry behavior.

### High-confidence conclusion
The current plugin is closer to a minimal OAuth bearer injector than to real Claude Code auth. The biggest correctness bug is the narrow `user:inference` scope on the Pro/Max path and refresh path. If we need "same flow and auth level as Claude Code", the plugin should be redesigned around Claude Code's full-scope Claude.ai flow, refresh semantics, auth-mode gating, and callback handling.
