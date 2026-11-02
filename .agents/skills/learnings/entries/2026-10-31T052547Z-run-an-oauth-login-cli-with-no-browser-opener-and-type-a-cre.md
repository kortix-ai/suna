---
recorded: 2026-10-31T05:25:47Z
incident_date: 2026-10-31
---
# Run an OAuth login CLI with no browser opener and type a credential only into a field you just resolved

**Rule:** Run any OAuth login CLI (`claude setup-token`, `claude auth login`,
`codex login`) with `xdg-open`, `open` and `BROWSER` replaced by a no-op and an
empty `HOME` / config dir. In a browser script, type a credential only into a
field you resolved in the same step, and stop when the lookup returns nothing:
never pass a ref from a helper that can print an empty string.

**Trigger surface:** Probing or testing a login flow on a dev box, writing an
agent-browser or Playwright script that fills a token, key or password.

**Incident:** 2026-10-31, while building Claude subscription models (branch
`claude-code`). (1) A probe ran `claude setup-token` on a PTXP box. The box's
`xdg-open` forwards to the owner's computer, the logged-in browser approved the
request, and the CLI minted a real 1-year subscription token into the probe's
output. (2) A demo script resolved the "Claude token" field with a helper that
printed an empty ref when the dialog had not opened. `fill` typed the token into
the composer and the script sent it as a chat message to a managed model. The
owner was asked to revoke the token; the local rows holding it were deleted.

**Enforcement:** `apps/api/src/projects/claude-subscription/setup-token.ts`
shims every browser opener and isolates `HOME` and `CLAUDE_CONFIG_DIR` for the
product's own login runs (`setup-token.test.ts`). Browser scripts: none yet: an
agent-browser helper that refuses `fill` with an empty ref.
