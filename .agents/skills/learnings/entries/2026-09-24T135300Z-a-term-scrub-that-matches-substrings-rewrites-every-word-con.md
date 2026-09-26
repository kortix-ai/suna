---
recorded: 2026-09-24T13:53:00Z
incident_date: 2026-09-24
commit: 9462922fa1
---
# A term scrub that matches substrings rewrites every word containing the term

**Incident.** A branch scrubbed a customer's name from the repository with a
case-insensitive substring replacement (merged 2026-09-23 20:27Z, PR #7526).
The name is a prefix of the word "essential", so every "essential" in the tree
became "samplecol": 35 occurrences in 29 files, and 0 "essential" left. The
sandbox Dockerfile then asked apt for `build-samplecol`. Nothing on the pull
request built the sandbox image, so the first build after the merge failed on
the provider (05:42Z) and every later one did too. Each preview waited 15
minutes for an image that could not exist and ran 0 API flows; dev kept
serving the previous image. The same rewrite removed the `essential` flag from
ECS container definitions (Terraform and the ECS preview script), changed a
model id in the LLM catalog, and changed prose, docs, and tests. `staging` and
`prod` never received it.

**Rule.** Scrub a term as a whole word, never as a substring. Before
committing a scrub, list every distinct word the replacement changed
(`git diff -U0 | grep '^+' | grep -oiE '\w*<replacement>\w*' | sort | uniq -c`)
and read it: a replacement that turns up inside other words is a corruption,
not a scrub. A change to the sandbox image's package list is checked on the
pull request, not after the merge.

**Enforcement.** `scripts/check-sandbox-apt-packages.sh` resolves the runtime
stage's apt packages against its base image (`apt-get install --dry-run`); the
`Sandbox image apt packages` job in `.github/workflows/ci.yml` runs it when the
Dockerfile, the script, or `ci.yml` changes. `scripts/check-blocked-terms.sh`
already matches blocked terms as whole words.
