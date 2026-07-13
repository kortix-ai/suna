provider "aws" { region = var.aws_region }

# CloudFront-scoped WAF resources must be created in us-east-1.
provider "aws" {
  alias  = "global"
  region = "us-east-1"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

module "repository_certificate" {
  source = "../../modules/acm-cloudflare"

  providers = {
    aws        = aws.global
    cloudflare = cloudflare
  }

  domain_name = var.repository_domain
  zone_id     = var.cloudflare_zone_id
  tags        = var.tags
}

module "publisher" {
  source = "../../modules/enterprise-release-publisher"

  providers = {
    aws        = aws
    aws.global = aws.global
  }

  name                       = var.name
  expected_account_id        = var.expected_account_id
  repository_bucket_name     = var.repository_bucket_name
  repository_domain          = var.repository_domain
  repository_certificate_arn = module.repository_certificate.certificate_arn
  github_oidc_provider_arn   = var.github_oidc_provider_arn
  github_repository          = var.github_repository
  github_environment         = var.github_environment
  github_refresh_environment = var.github_refresh_environment
  customer_event_bus_arns    = var.customer_event_bus_arns
  tags                       = var.tags
}

resource "cloudflare_record" "repository" {
  zone_id = var.cloudflare_zone_id
  name    = var.repository_domain
  type    = "CNAME"
  content = module.publisher.cloudfront_domain_name
  ttl     = 300
  proxied = false
}

output "publisher" { value = module.publisher }
