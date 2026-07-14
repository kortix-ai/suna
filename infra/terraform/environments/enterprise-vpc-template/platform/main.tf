# Platform stage (ECS model): the cluster stage builds the whole runtime plane,
# including the shared ALB. Under EKS this stage installed Helm controllers,
# External Secrets, and external-dns. On ECS none of that exists — the only
# post-cluster step is aliasing the two application domains at the ALB, which
# replaces what external-dns used to do.

data "terraform_remote_state" "cluster" {
  backend = "s3"
  config = {
    bucket         = var.state_bucket
    key            = var.cluster_state_key
    region         = var.aws_region
    dynamodb_table = var.lock_table
    encrypt        = true
    kms_key_id     = var.state_kms_key_arn
  }
}

locals {
  instance = data.terraform_remote_state.cluster.outputs.instance
  app_domains = {
    api      = local.instance.api_domain
    frontend = local.instance.frontend_domain
  }
}

provider "aws" { region = var.aws_region }

resource "aws_route53_record" "app_alias" {
  for_each = local.app_domains

  zone_id = local.instance.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = local.instance.alb_dns_name
    zone_id                = local.instance.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "app_alias_ipv6" {
  for_each = local.app_domains

  zone_id = local.instance.route53_zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = local.instance.alb_dns_name
    zone_id                = local.instance.alb_zone_id
    evaluate_target_health = true
  }
}

output "app_dns_records" {
  value = { for k, r in aws_route53_record.app_alias : k => r.fqdn }
}
