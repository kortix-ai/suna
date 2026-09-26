---
recorded: 2026-08-29T17:06:58Z
incident_date: 2026-08-29
commit: c8af6ed439
---
# A guard nobody armed is not a guard, and a path-only allowlist is a hole

Audit of the plaintext-`.env` defenses, prompted by "are we sure a new dev
can't commit a plaintext .env?". Three defenses existed. Two did not do what
the docs claimed.

**1. The pre-commit hook was never armed.** `.githooks/pre-commit` is
version-controlled and good — it auto-*encrypts* every staged `.env`. But it
only runs after `git config core.hooksPath .githooks`, which nothing executed.
No `prepare`, no `postinstall`, not in `scripts/setup-env.sh`, not in README or
CONTRIBUTING. It was documented in the hook's own comment header and one line of
an agent skill file. A clone + `pnpm install` + `git commit` had **zero** local
protection. Proven in a throwaway repo: hooks unarmed → `sk_live_…` landed in
the commit; hooks armed → the same commit carried ciphertext, plaintext grep
count `0`.

**2. gitleaks was allowlisted over the exact leak surface.** `.gitleaks.toml`
allowlist #1 named the six encrypted profiles by `paths` with **no**
`condition = "AND"` and **no** `regexes`. A gitleaks allowlist that only
constrains paths exempts every finding in those files. A committed plaintext
`apps/api/.env` holding a Postgres password, an HMAC secret, and a
Stripe-shaped key scanned as `no leaks found`, exit `0`. The other three
allowlists in the same file were written correctly, with `condition = "AND"`
— the bug was one missing line in one block.

**3. The remaining net was thinner than assumed.** GitHub push protection is
enabled, but is provider-pattern based. After tightening the allowlist, gitleaks
caught `INTERNAL_HMAC_SECRET` (generic-api-key) and still missed the plaintext
`postgres://kortix:S3cr3tP4ssw0rd@host` URL.

**Rules.**
1. **A guard that requires a manual activation step is off.** Assume every
   optional setup line was skipped, because it was. Arm it from something the
   developer already runs — here, the root `package.json` `prepare` script,
   which `pnpm install` executes (verified: `core.hooksPath` = `.githooks`
   after a bare `pnpm install`).
2. **Never write a path-only gitleaks allowlist.** `paths` alone exempts the
   whole file. Pair it with `condition = "AND"` **and** `regexes` (plus
   `regexTarget = "line"` when exempting a file *format* rather than a value)
   so only the intended lines are exempt and a real secret still fails.
   `condition = "AND"` with no `regexes` is still path-only — the AND has
   nothing to intersect. The first version of the tripwire below checked only
   the condition and would have passed that shape; review caught it.
3. **Know each gate's shape before trusting it.** `dotenvx ext precommit`
   inspects only the **staged** diff — correct for a hook, a no-op in CI where
   nothing is staged. gitleaks runs on the **pull request** — after the commit,
   after the push, on a public repo. Only the hook runs before the commit
   exists. A gate list is not a defense unless you know when each one fires.
4. **Pattern matching is not a structural guarantee.** For a file format whose
   whole invariant is "every value is ciphertext", assert *that*, not a
   catalogue of secret shapes.
5. Test a security control in **both** directions. "It passes on the real repo"
   proves nothing about whether it fails on a leak.

*Automation:* root `prepare` arms the hooks on `pnpm install`;
`scripts/check-env-encrypted.sh` (`pnpm secrets:check`) structurally asserts
every value in a committed `.env` profile starts with `encrypted:`;
`.github/workflows/secrets-guard.yml` runs it on every PR **and** fails the
build if a path-only allowlist reappears in `.gitleaks.toml`.

*Incident:* No leak occurred. Found by audit, closed the same session. All
findings reproduced in throwaway repos with real gitleaks 8.30.1 and the repo's
own config; no real secret was ever written to disk in plaintext.
