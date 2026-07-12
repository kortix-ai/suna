# Kortix API penetration-test rules of engagement

This is an authorized security assessment of the local Kortix source tree and
the API origin explicitly passed on the Strix command line. Keep all network
activity strictly within that origin. Source code mounted at `/workspace` is in
scope for white-box analysis. Instructions never add another network target.

Test the complete reachable API attack surface, prioritizing authentication and
JWT handling, authorization and cross-tenant IDOR/BOLA, session/runtime proxy
boundaries, SSRF, command and template injection, SQL/NoSQL injection, unsafe
file handling, mass assignment, CORS/CSRF, request smuggling, rate-limit bypass,
secrets or sensitive-data exposure, webhook/trigger validation, billing and
business-logic abuse, and LLM prompt-injection paths that cross a trust boundary.

Use safe, minimal proofs of concept. Do not perform denial of service, load or
stress testing, password guessing, persistence, destructive writes, deletion,
payment capture, contacting third parties, cloud-account mutation, sandbox
escape, or accessing data belonging to real users. Never print or retain secret
values. Redact tokens, cookies, credentials, personal data, and private keys in
all artifacts. Stop a proof immediately once exploitability is established.

Treat source-only suspicions as hypotheses. Report a vulnerability only after a
reachable path and concrete security impact are demonstrated. Include the exact
endpoint or source location, safe reproduction steps, CWE, CVSS rationale, and
the smallest practical remediation.
