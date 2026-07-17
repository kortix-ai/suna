Self-host SSO sign-in fix and a Cloudflare Access setup guide

**Fixed**
- Self-hosted sign-in via SSO/OAuth no longer lands you on an unreachable `0.0.0.0:3000` address after authenticating. The post-login redirect now uses your instance's public URL, so SSO and social logins complete cleanly behind a reverse proxy.
- The LLM gateway now deploys reliably again on Kubernetes — a missing configuration value that could stall the gateway rollout is set, so releases roll the gateway forward without manual intervention.

**Added**
- A step-by-step guide for setting up SSO with Cloudflare Access (SAML), matching how Cloudflare Access actually behaves.
