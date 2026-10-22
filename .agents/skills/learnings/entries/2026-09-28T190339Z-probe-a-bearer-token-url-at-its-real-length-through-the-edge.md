---
recorded: 2026-09-28T19:03:39Z
incident_date: 2026-09-28
---
# Probe a bearer-token URL at its real length through the edge before you ship it

**Rule:** A token that rides in a URL path must pass the edge at its real
length. Every AWS ALB here sits behind `kortix-alb-waf`, whose
`AWSManagedRulesCommonRuleSet` blocks paths over 1024 bytes unless
`SizeRestrictions_URIPATH` is in Count. Probe a new path-token route with a
max-size token against dev-api before you ship it.

**Trigger surface:** Adding or growing an encrypted/stateless token in a URL
path (setup links, approval links, share links), or editing the regional
WebACL overrides.

**Incident:** 2026-09-28, prod. A secret setup link whose token was 1143
chars loaded its page on the web origin, but the page's
`GET /v1/setup-links/secret/<token>` got the WAF's HTML 403. That response
has no CORS headers, so the browser reported a CORS error and the human could
not submit the secret. Every setup-link token over ~1000 chars failed on dev,
staging, and prod. Fixed live in us-west-2, eu-west-2, and us-east-2 by
setting `SizeRestrictions_URIPATH` to Count; the Terraform-managed us-east-2
WebACL and `infra/terraform/security-baseline/README.md` record it.

**Enforcement:** none yet: a deployed smoke that requests
`/v1/setup-links/secret/ksl_<1100 chars>` and expects the API's 404 JSON, not
a 403 HTML page. Diagnose quickly: a CORS error on `api.kortix.com` with a
`403 text/html` response and `x-backend: ecs-fargate` is the WAF, not the API.
