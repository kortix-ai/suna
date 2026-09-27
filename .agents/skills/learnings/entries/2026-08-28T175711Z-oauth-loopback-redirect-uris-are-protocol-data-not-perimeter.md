---
recorded: 2026-08-28T17:57:11Z
commit: 0f7b09d8f0
---
# OAuth loopback redirect URIs are protocol data, not perimeter SSRF attempts

- **Incident (2026-08-28, v0.13.7 release QA):** flow `OAU-8` received an HTML
  `403` before the API for `GET /v1/oauth/authorize` when `redirect_uri` used
  `http://localhost` or `http://127.0.0.1`. The same request reached the API
  when it used an HTTPS public origin. Dev, staging, and production reproduced
  the block. The AWS Common managed rule group classified the loopback query
  argument as SSRF, but OAuth public and native clients require loopback
  redirects.
- **Rule:** exclude loopback redirect values from the Common managed rule group
  only when the method is `GET`, the path is exactly `/v1/oauth/authorize`, and
  `redirect_uri` starts with `http://localhost` or `http://127.0.0.1`. Do not
  disable the managed rule or its query inspection globally. Keep
  KnownBadInputs and IP reputation inspection active. The API must validate the
  complete redirect URI against the registered client.
- **Enforcement:**
  `infra/terraform/scripts/test_web_waf_associations.py` pins the scoped
  Terraform statement. Deployed release flow `OAU-8` proves that a registered
  loopback redirect reaches the API and completes authorization.
