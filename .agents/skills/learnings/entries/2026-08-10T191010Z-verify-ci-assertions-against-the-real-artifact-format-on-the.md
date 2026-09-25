---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# Verify CI assertions against the real artifact format on the CI OS

**When:** writing shell assertions in workflows (grep/awk over curl output,
cookie jars, headers). curl's Netscape cookie-jar puts the domain in the FIRST
field with an `#HttpOnly_` prefix — a tab-anchored grep can never match; and GNU
grep -E treats `\t` in single quotes as a literal `t` while macOS grep interprets
it, so a locally-green pattern can be dead on ubuntu runners. Use ANSI-C
quoting (`$'\t'`) and test the exact pattern in an ubuntu container.
*Incident:* staging web verify failed twice on the same one-line assertion.
