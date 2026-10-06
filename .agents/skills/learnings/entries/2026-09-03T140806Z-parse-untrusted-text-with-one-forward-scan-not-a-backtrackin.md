---
recorded: 2026-09-03T14:08:06Z
incident_date: 2026-09-03
commit: 9e461e27c2
---
# Parse untrusted text with one forward scan, not a backtracking regular expression

**When:** trimming URLs or extracting text from upstream HTML and other untrusted response bodies.
**Incident:** the Pi PR introduced three high-severity CodeQL alerts; 30,000 trailing-slash
candidates took 363 ms, and 10,000 unclosed HTML tags took 425 ms on a developer machine.
**Rule:** use an index or cursor that advances monotonically. Add an adversarial-size regression test.
**Enforcer:** CodeQL blocks polynomial regexes; the worker and SDK tests cap both cases at 100 ms.
