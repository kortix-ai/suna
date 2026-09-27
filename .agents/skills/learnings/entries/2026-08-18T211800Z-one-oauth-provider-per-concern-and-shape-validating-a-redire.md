---
recorded: 2026-08-18T21:18:00Z
incident_date: 2026-08-18
commit: bbe5e9dad5
---
# One OAuth provider per concern; and shape-validating a redirect is not authorizing it

**When:** wiring any OAuth/identity flow, reusing an existing provider for a
second purpose, or writing any route that redirects somewhere a caller named.

"Link a GitHub account" died on dev with Supabase's
`{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`.
Nothing had changed in the code. Linking a GitHub **App installation** to a
Kortix account was minting its identity proof through Supabase's
general-purpose "Sign in with GitHub" **login** provider — so an account/org
feature's uptime hung on a per-Supabase-project dashboard toggle that exists
for unrelated product login and that no IaC in this repo manages. Supabase
never authenticated anyone's org; it was an incidental token-minting detour.
Meanwhile the GitHub App's OWN OAuth client — whose `client_id`/`client_secret`
the manifest flow already captured and stored — sat unread in the codebase.

The rule: **one integration per concern.** Before reusing an auth provider for
a second purpose, ask what a failure of the first purpose does to the second.
If the answer is "takes it down," they must not share. Prefer the credential
the feature already owns over the one that happens to be nearby.

**The expensive part was the replacement, not the diagnosis.** The new route
took a `frontend_origin` query param, signed it into the OAuth state, and had
the callback redirect the exchanged GitHub user token to it. Validation was
`normalizeGitHubFrontendOrigin` — which checks the *shape* (https, or http on
localhost) and NOT that the origin is ours. Every attacker HTTPS origin
passed, so `?frontend_origin=https://attacker.example` exfiltrated a victim's
user-to-server token, replayable against the installation-linking endpoints
(CWE-601, HIGH — found by strix-security in review).

**Shape validation is not authorization.** That sentence is the learning. A
URL being well-formed, https, and parseable says nothing about whether you are
allowed to send a credential to it. An allowlist — or better, no parameter at
all — is the check.

And the near-miss inside the near-miss: an earlier commit in the same PR
"fixed the open redirect" by normalizing that param before an early
`oauth_not_configured` return. That closed the *smaller* hole and left the
primary exfiltration path fully open, while reading like a completed security
fix in the diff and the commit message. **When you fix a redirect bug, enumerate
every branch that emits a Location header and every value that can reach one**
— fixing the branch you happened to be looking at is how a HIGH survives a
"security fix" commit. The final fix deleted the parameter entirely: the state
now carries only `{nonce, exp}` and both routes always land on `frontendUrl()`,
so there is no caller-influenced redirect target left to re-trust later.

Corollaries, all paid for in this same change:

- **Config that lives only in a vendor dashboard will drift and nobody will
  know.** Grep proved no Terraform anywhere manages Supabase Auth providers;
  each environment is hand-toggled. A feature depending on such config has no
  gate that can catch its absence — the first signal is a user hitting a 400.
- **Assert the negative.** The ke2e flow that earned its keep asserts where the
  redirect must NOT go ("never contains the attacker origin"), not which reason
  code came back. A happy-path assertion passes an open redirect; only the
  negative one fails it. It also has to cover every branch separately — the
  unconfigured-OAuth branch needed its own case because which branch fires
  depends on deployment state.
- **A branch no test configuration reaches is untested, however green the run.**
  The open-redirect branch only fires when OAuth is unconfigured; unit tests,
  tsc, lint and hand-run curl (against a *configured* API) were all green on it.
- An App's OAuth callback is `callback_urls` in the manifest, a different field
  from `redirect_url` (post-creation only); and binding new state to
  `SUPABASE_JWT_SECRET` broke instantly because hosted deployments set
  `KORTIX_GITHUB_APP_STATE_SECRET` and no Supabase JWT secret. Reuse the
  resolver the neighbouring feature already uses rather than a same-shaped one.
*Incident:* dev "Link a GitHub account" down; fixed in PR #6526. Four defects
were introduced and caught inside that one PR — an open redirect, a token
exfiltration (CWE-601), a signing secret unset in this deployment, and a
missing manifest field — none by a static gate.
