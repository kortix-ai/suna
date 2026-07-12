# Kortix pull-request security review

Perform an authorized, source-aware security review of the checked-out Kortix
repository. In pull requests, prioritize the diff from `origin/main` and follow
reachable data flow into surrounding code. Do not contact production services
or any target outside the mounted repository.

Focus on authentication, authorization, tenant isolation, untrusted input to
commands/queries/templates/URLs, SSRF, unsafe files and archives, secret leakage,
cryptographic misuse, CORS/CSRF, webhook verification, runtime proxy boundaries,
mass assignment, dependency risk, and business-logic regressions. Do not execute
destructive operations or print secret values. Report only findings with a
concrete reachable path, impact, CWE, source location, and practical fix.
