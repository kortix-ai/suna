# ── Cloudflare Access (Zero Trust) gate for qa.kortix.com ─────────────────────
#
# The report bucket is private and the portal is served by the in-cluster nginx
# pod behind the ALB, with the qa.kortix.com record proxied through Cloudflare
# (orange-cloud). This puts Cloudflare Access in front of that hostname so only
# authenticated Kortix identities can open any report (including the per-PR
# links posted by qa-pr). Access denies by default; the single allow policy
# below is the allowlist.
#
# Prerequisite: an identity provider (Google / GitHub / one-time-PIN) must exist
# in the Cloudflare Zero Trust account. Access uses whatever IdPs are configured;
# this module does not create one (that needs IdP OAuth credentials).

resource "cloudflare_zero_trust_access_application" "qa" {
  count                      = var.enable_access ? 1 : 0
  account_id                 = var.cloudflare_account_id
  name                       = var.access_app_name
  domain                     = var.host
  type                       = "self_hosted"
  session_duration           = var.access_session_duration
  auto_redirect_to_identity  = true
  app_launcher_visible       = var.access_app_launcher_visible
  http_only_cookie_attribute = true

  lifecycle {
    precondition {
      condition     = var.cloudflare_account_id != ""
      error_message = "enable_access = true requires cloudflare_account_id (set TF_VAR_cloudflare_account_id)."
    }
    precondition {
      condition     = length(var.access_allowed_email_domains) > 0 || length(var.access_allowed_emails) > 0
      error_message = "Cloudflare Access needs at least one allowed email or email domain, otherwise nobody can open the portal."
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "qa_allow" {
  count          = var.enable_access ? 1 : 0
  application_id = cloudflare_zero_trust_access_application.qa[0].id
  account_id     = var.cloudflare_account_id
  name           = "Allow Kortix team"
  precedence     = 1
  decision       = "allow"

  include {
    email        = var.access_allowed_emails
    email_domain = var.access_allowed_email_domains
  }
}
