resource "aws_acm_certificate" "public" {
  domain_name               = var.api_domain
  subject_alternative_names = [var.frontend_domain]
  validation_method         = "DNS"
  key_algorithm             = "EC_prime256v1"

  options {
    certificate_transparency_logging_preference = "ENABLED"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

data "aws_route53_zone" "public" {
  zone_id      = var.route53_zone_id
  private_zone = false
}

locals {
  public_zone_name = lower(trimsuffix(data.aws_route53_zone.public.name, "."))
}

resource "terraform_data" "public_dns_guard" {
  input = {
    zone     = data.aws_route53_zone.public.name
    api      = var.api_domain
    frontend = var.frontend_domain
  }

  lifecycle {
    precondition {
      condition = alltrue([for domain in [var.api_domain, var.frontend_domain] :
        lower(domain) == local.public_zone_name || endswith(lower(domain), ".${local.public_zone_name}")
      ])
      error_message = "api_domain and frontend_domain must both belong to route53_zone_id."
    }
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.public.domain_validation_options : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.public.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.value]

  depends_on = [terraform_data.public_dns_guard]
}

resource "aws_acm_certificate_validation" "public" {
  certificate_arn         = aws_acm_certificate.public.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}
