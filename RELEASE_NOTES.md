Agents now always answer your first message, plus SSO and gateway fixes

This release fixes a timing bug that could make an agent miss the very first message of a session, tightens single sign-on for teams, makes gateway errors say what actually went wrong, and hardens how OAuth tokens are stored.

### Fixed
- **Agents now reliably reply to your first message.** On a fast cold start, the agent could fire your opening prompt before it had finished subscribing to its own event stream — so a quick first turn finished in that gap and the reply was lost (most visible as a silent first message in Slack). The agent now subscribes first, reconciles anything it missed on connect, and delivers each turn's end exactly once.
- **Clearer gateway errors instead of a generic failure.** When an upstream model provider failed mid-response (for example, an overloaded or request-too-large error on an otherwise-started stream), the gateway used to bury it as a generic "empty completion" and retry the same failing provider until it gave up. It now surfaces the real upstream error and message, drops the failed provider immediately, and fails over to another one when available.
- **SSO group-to-role sync now works for SAML.** SAML providers weren't registered with a group-claim mapping, so the group attribute never reached the token and group-driven role assignment silently did nothing (login still worked). Providers now register with the correct mapping, and the SSO setup card documents the common identity-provider gotchas.
- **SCIM group membership applies to pending invites.** A user provisioned via SCIM but not yet signed in was silently dropped from pushed groups. Their group is now recorded on the invite and applied automatically when they accept, matching how project access already works.

### Improved
- **Sandbox templates show which provider they use.** Each template card and recent build now carries a small provider chip (Daytona, Platinum, Managed), and the templates section is tidier and less cluttered.
- **CLI secrets match the web app.** `kortix secrets set --identifier KEY=VALUE` lets you store more than one value under the same key from the terminal, and `kortix secrets ls` now lists by identifier and flags any missing required keys — bringing the CLI in line with the web Add-secret experience.
- **CLI token context shows your environment grant.** `kortix token` / `whoami --token-only` now include the `env` part of an agent grant (not just connectors and CLI access), and a bound default project points you at `kortix projects use` to switch.

### Behind the scenes
- OAuth server access and refresh tokens are now stored with peppered scrypt, matching every other credential (previously plain SHA-256). Existing tokens keep working until they expire.
- All OpenRouter usage now attributes to one canonical app (www.kortix.com) instead of splitting across per-environment entries.
- Removed an unused internal session-LLM route that no client called.
- Trimmed frontend build spend by skipping builds that don't touch the frontend and gating preview builds.

Kortix is open and source-available.
