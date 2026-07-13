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
